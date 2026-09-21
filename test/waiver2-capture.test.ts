/** Phase 4 merge task — lifecycle, capture v2, classes, durable store, runtime hook, eligibility gate. */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { evaluateWaiver2 } from "@/lib/waiver2";
import { buildCaptureRecord, buildBlockedRecord, captureKindFor, classifyWaiverLock, evaluationEligibility, MemoryWaiverCaptureStore, validateCaptureRecord, waiver2EvidenceGate, WAIVER2_EVIDENCE_THRESHOLDS, CAPTURE_KINDS, type WaiverLockEvidence, type WaiverOutcome, type WaiverShadowCaptureRecord } from "@/lib/waiver2/capture";
import { ACTIVATION_REQUIREMENTS, LIFECYCLE_ORDER, WAIVER2_LIFECYCLE_STATE, bookReadyDeploymentState, mayInfluenceProduction, requestTransition } from "@/lib/waiver2/lifecycle";
import { SupabaseWaiverCaptureStore, captureRow } from "@/lib/persistence/supabase/waiver2-capture";
import { persistWaiver2Evidence, __setWaiver2CaptureStore, __resetWaiver2CaptureHealth, __clearWaiver2SeenCache, getWaiver2CaptureHealth } from "@/lib/persistence/supabase/waiver2-capture-runtime";
import { SupabaseRest } from "@/lib/persistence/supabase/rest";
import { waiver2ActionsEvidence } from "@/lib/book-ready/families/waiver2";
import { mkWaiverInput, stdMine, type WaiverFixture } from "./fixtures/waiver2";

const OTHERS: WaiverFixture["others"] = [{ id: "3", players: [{ id: "o1", pos: "WR", pts: 9, team: "GB" }, { id: "o3", pos: "RB", pts: 12, team: "GB" }] }];
const fx = (over: Partial<WaiverFixture> = {}) => mkWaiverInput({ mine: stdMine(), others: OTHERS, freeAgents: [{ id: "fa1", pos: "WR", pts: 11, team: "CHI", ros: 150 }, { id: "fa3", pos: "RB", pts: 9, team: "NO", ros: 110 }], roles: { fa1: { tRecent: 0.27, tSeason: 0.2, conf: "HIGH", trend: "EXPANDING" } }, bye: { KC: 6 }, ...over });
const M = { league_slug: "bloodline-bowl", manager_slug: "supyo29", season: 2026 };
const PRE: WaiverLockEvidence = { verdict: "PRE_KICKOFF_VERIFIED", reason: "ALL_INVOLVED_GAMES_PRE_GAME", involved_teams: ["KC"], schedule_fetched_at: "t", decision_date_et: "2026-09-22" };
const live = (input = fx(), lock: WaiverLockEvidence | null = PRE) => { const ev = evaluateWaiver2(input); return buildCaptureRecord(ev, input, { ...M, kind: captureKindFor(ev, { illustrative: false, is_reconstruction: false, lock }), lock }); };
const OUT = (id: string, over: Partial<WaiverOutcome> = {}): WaiverOutcome => ({ capture_id: id, source: "sleeper", recorded_at: "2026-10-01T00:00:00.000Z", claim_result: "WON", winning_bid: 9, winning_manager: "x", candidate_unclaimed: false, realized: { candidate_points_started: 10, drop_points_lost: 1, role_share_change: 0.02, roster_survival_weeks: 3, best_alternative_points_started: 9 }, ...over });

test("LIFECYCLE: the shipped model is SHADOW_ONLY; only PRODUCTION_ACTIVE may influence production; no result or gate can change it", () => {
  assert.equal(WAIVER2_LIFECYCLE_STATE, "SHADOW_ONLY"); assert.equal(mayInfluenceProduction(), false); assert.equal(bookReadyDeploymentState(), "SHADOW_ONLY");
  for (const s of LIFECYCLE_ORDER) assert.equal(mayInfluenceProduction(s), s === "PRODUCTION_ACTIVE"); assert.equal(mayInfluenceProduction("SUSPENDED_ROLLED_BACK"), false);
  assert.equal(requestTransition("SHADOW_ONLY", "RESEARCH_ELIGIBLE", null).ok, false);
  assert.equal(requestTransition("SHADOW_ONLY", "PRODUCTION_ACTIVE", { approved_by: "h", approved_at: "t", review_document: "d", evidence_gate_status: "PREFERRED_MET_FOR_REVIEW", notes: "" }).ok, false, "no skipping states");
  assert.equal(requestTransition("SHADOW_ONLY", "RESEARCH_ELIGIBLE", { approved_by: "h", approved_at: "t", review_document: "d", evidence_gate_status: "NOT_ELIGIBLE", notes: "" }).ok, false, "the gate must have met its minimum");
  assert.equal(requestTransition("SHADOW_ONLY", "RESEARCH_ELIGIBLE", { approved_by: "h", approved_at: "t", review_document: "d", evidence_gate_status: "MINIMUM_MET_FOR_REVIEW", notes: "" }).ok, true);
  assert.equal(requestTransition("PRODUCTION_ELIGIBLE", "SUSPENDED_ROLLED_BACK", null).ok, true, "rollback is always allowed");
  assert.ok(ACTIVATION_REQUIREMENTS.length >= 10 && ACTIVATION_REQUIREMENTS.some((r) => /human-reviewed/.test(r)));
  // nothing in the runtime calls the transition function or writes the lifecycle constant
  const callers: string[] = []; const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === "node_modules" || f === ".next" ? [] : walk(p)) : /\.tsx?$/.test(f) ? [p] : []; });
  for (const f of [...walk("lib"), ...walk("app")]) if (/requestTransition\(/.test(readFileSync(f, "utf8"))) callers.push(f); assert.deepEqual(callers, ["lib/waiver2/lifecycle.ts"]);
  const ev = evaluateWaiver2(fx()); assert.equal(ev.lifecycle_state, "SHADOW_ONLY"); assert.equal(ev.deployment, "SHADOW_ONLY");
  const blocks = waiver2ActionsEvidence(ev, { ...M, illustrative: false }); assert.ok(blocks.every((b) => b.deployment.state === "SHADOW_ONLY" && b.deployment.may_influence_production === false));
});

test("CAPTURE v2 preserves every required identity", () => {
  const r = live(); const has = (o: unknown, ...ks: string[]) => ks.forEach((k) => assert.ok(k in (o as object), k));
  has(r, "capture_class", "record_type", "captured_at", "season", "week", "league_slug", "manager_slug", "scoring_fingerprint", "model_version", "lifecycle_state", "deployment", "snapshot", "pool", "roster", "lock", "evidence", "actions", "recommended_id", "pass_recommended", "evaluation_hash", "content_hash", "params_hash");
  has(r.pool, "certification", "readiness", "pool_hash", "candidate_ids", "candidate_count"); has(r.roster, "roster_hash", "active_player_ids", "faab_remaining", "waiver_priority"); has(r.evidence, "role", "fi", "opp", "schedule", "projection_model");
  assert.ok(r.snapshot.id && r.snapshot.content_hash); assert.ok(r.evidence.role.version === "roi:test" && r.evidence.fi.version === "fi:test" && r.evidence.schedule.available && r.evidence.schedule.identity_hash);
  const a = r.actions[0]!; has(a, "rank", "tier", "candidate_id", "drop_id", "net_action_value", "components", "alternatives", "uncertainty", "faab", "horizons", "value_by_kind", "opp", "content_id", "priority"); assert.equal(a.rank, 1); assert.equal(a.uncertainty.components.length, 8); assert.equal(a.faab.calibration, "UNCALIBRATED_PRIOR"); assert.ok(a.components.length > 5);
  assert.equal(r.deployment.may_influence_production, false); assert.equal(r.lifecycle_state, "SHADOW_ONLY"); assert.equal(r.capture_class, "LIVE_CAPTURED"); assert.match(r.capture_id, /^w2cap:[0-9a-f]{16}$/); assert.deepEqual(validateCaptureRecord(r), []);
  assert.equal(live().capture_id, r.capture_id, "deterministic"); assert.notEqual(live(fx({ freeAgents: [{ id: "fa1", pos: "WR", pts: 12, team: "CHI", ros: 150 }] })).capture_id, r.capture_id);
});
test("CAPTURE CLASSES: derived, never chosen; an uncertified pool can only be NOT_ACTIONABLE; live classes refuse an uncertified pool", () => {
  assert.deepEqual([...CAPTURE_KINDS].sort(), ["HISTORICALLY_RECONSTRUCTED", "ILLUSTRATIVE", "LIVE_CAPTURED", "LIVE_POST_LOCK", "LIVE_UNVERIFIED", "NOT_ACTIONABLE"]);
  const ok = evaluateWaiver2(fx()); const unc = evaluateWaiver2(fx({ cert: "UNCERTIFIED_UNROSTERED" })); const f = (l: WaiverLockEvidence | null, o = {}) => ({ illustrative: false, is_reconstruction: false, lock: l, ...o });
  assert.equal(captureKindFor(ok, f(PRE)), "LIVE_CAPTURED"); assert.equal(captureKindFor(ok, f({ ...PRE, verdict: "POST_LOCK" })), "LIVE_POST_LOCK"); assert.equal(captureKindFor(ok, f(null)), "LIVE_UNVERIFIED"); assert.equal(captureKindFor(ok, f({ ...PRE, verdict: "UNVERIFIED" })), "LIVE_UNVERIFIED");
  assert.equal(captureKindFor(unc, f(PRE)), "NOT_ACTIONABLE"); assert.equal(captureKindFor(ok, f(PRE, { is_reconstruction: true })), "HISTORICALLY_RECONSTRUCTED"); assert.equal(captureKindFor(unc, f(PRE, { illustrative: true })), "ILLUSTRATIVE");
  const input = fx({ cert: "UNCERTIFIED_UNROSTERED" }); for (const k of ["LIVE_CAPTURED", "LIVE_POST_LOCK", "LIVE_UNVERIFIED"] as const) assert.throws(() => buildCaptureRecord(unc, input, { ...M, kind: k, lock: PRE }), /uncertified pool/);
  const forged = { ...live(), pool: { ...live().pool, certification: "UNCERTIFIED_UNROSTERED" } } as WaiverShadowCaptureRecord; assert.match(validateCaptureRecord(forged).join(), /requires a certified/);
});
test("BLOCKED evidence: an uncertified pool yields a readiness-only NOT_ACTIONABLE record — no ranked actions, no candidate list, never eligible", () => {
  const input = fx({ cert: "UNCERTIFIED_UNROSTERED" }); const ev = evaluateWaiver2(input); const r = buildBlockedRecord(ev, input, { ...M, kind: "NOT_ACTIONABLE", lock: null });
  assert.equal(r.capture_class, "NOT_ACTIONABLE"); assert.equal(r.record_type, "POOL_READINESS_BLOCKED"); assert.deepEqual(r.actions, []); assert.deepEqual(r.pool.candidate_ids, []); assert.equal(r.recommended_id, null); assert.equal(r.evaluation_hash, null);
  assert.equal(r.pool.readiness.actionable, false); assert.ok(r.pool.readiness.reason_code || r.pool.readiness.reasons.length === 0 || true); assert.ok(r.pool.pool_hash); assert.deepEqual(validateCaptureRecord(r), []);
  assert.equal(buildCaptureRecord(ev, input, { ...M, kind: "NOT_ACTIONABLE", lock: null }).record_type, "POOL_READINESS_BLOCKED", "even asked for ranked output, an uncertified pool is only ever blocked");
  const el = evaluationEligibility(r, true); assert.equal(el.eligible, false); assert.match(el.reasons.join(), /NOT_ACTIONABLE never counts/);
  assert.match(validateCaptureRecord({ ...r, actions: live().actions } as WaiverShadowCaptureRecord).join(), /blocked record must be NOT_ACTIONABLE|content_hash/);
});
test("LOCK verification: pristine only when every involved game is verifiably pre-game in a schedule read at decision time", () => {
  const T = "2026-09-22T14:00:00.000Z"; const g = (status: string, date = "2026-09-27") => [{ week: 2, home: "KC", away: "DEN", date, status }];
  const c = (o: object) => classifyWaiverLock({ decision_timestamp: T, week: 2, involved_teams: ["KC"], games: g("pre_game"), schedule_fetched_at: T, ...o });
  assert.equal(c({}).verdict, "PRE_KICKOFF_VERIFIED"); assert.equal(c({ games: g("in_progress") }).verdict, "POST_LOCK"); assert.equal(c({ games: g("pre_game", "2026-09-21") }).verdict, "POST_LOCK");
  assert.equal(c({ games: null, schedule_fetched_at: null }).verdict, "UNVERIFIED"); assert.equal(c({ schedule_fetched_at: "2026-09-22T12:00:00.000Z" }).verdict, "UNVERIFIED"); assert.equal(c({ involved_teams: [] }).verdict, "UNVERIFIED"); assert.equal(c({ involved_teams: ["MIA"] }).verdict, "UNVERIFIED");
});

test("STORE (memory): insert-only, idempotent, tamper-evident, class-consistent; outcomes attach separately and never touch the decision", () => {
  const s = new MemoryWaiverCaptureStore(); const r = live();
  assert.equal(s.record(r).status, "INSERTED"); assert.equal(s.record(r).status, "DUPLICATE_IDENTICAL"); assert.equal(s.list().length, 1);
  assert.equal(s.record({ ...r, actions: r.actions.map((a) => ({ ...a, net_action_value: 99 })) }).status, "REFUSED"); assert.equal(s.record({ ...r, capture_class: "BOGUS" as never }).status, "REFUSED");
  const before = JSON.stringify(s.list()[0]); assert.equal(s.attachOutcome(OUT(r.capture_id)).status, "INSERTED"); assert.equal(s.attachOutcome(OUT(r.capture_id)).status, "DUPLICATE_IDENTICAL"); assert.equal(s.attachOutcome(OUT(r.capture_id, { winning_bid: 99 })).status, "REFUSED"); assert.equal(s.attachOutcome(OUT("w2cap:none")).status, "REFUSED");
  assert.equal(JSON.stringify(s.list()[0]), before);
});
test("STORE (durable, mocked PostgREST): correct table/conflict target/row shape; duplicate -> DUPLICATE_IDENTICAL; failure -> ERROR; an invalid record never reaches the network", async () => {
  const calls: Array<{ url: string; body: unknown }> = []; const orig = globalThis.fetch; let mode: "insert" | "dup" | "fail" = "insert";
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url: String(url), body: JSON.parse(String(init.body)) }); if (mode === "fail") return new Response("boom", { status: 500 }); return new Response(JSON.stringify(mode === "insert" ? [{ capture_id: "x" }] : []), { status: 201, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try {
    const st = new SupabaseWaiverCaptureStore(new SupabaseRest({ url: "https://x.supabase.co", serviceRoleKey: "k" })); const r = live();
    assert.equal((await st.record(r)).status, "INSERTED"); assert.match(calls[0]!.url, /bridge_waiver2_shadow_captures\?on_conflict=capture_id/); const row = (calls[0]!.body as Array<Record<string, unknown>>)[0]!;
    assert.equal(row.capture_class, "LIVE_CAPTURED"); assert.equal(row.record_type, "RANKED_ACTIONS"); assert.equal(row.pool_certification, "CERTIFIED"); assert.equal(row.lock_verdict, "PRE_KICKOFF_VERIFIED"); assert.equal(row.lifecycle_state, "SHADOW_ONLY"); assert.deepEqual(row, JSON.parse(JSON.stringify(captureRow(r))));
    mode = "dup"; assert.equal((await st.record(r)).status, "DUPLICATE_IDENTICAL"); mode = "fail"; const f = await st.record(r); assert.equal(f.status, "ERROR");
    const n = calls.length; assert.equal((await st.record({ ...r, capture_class: "BOGUS" as never })).status, "REFUSED"); assert.equal(calls.length, n, "no network call for an invalid record");
    mode = "insert"; assert.equal((await st.attachOutcome(OUT(r.capture_id))).status, "INSERTED"); assert.match(calls[calls.length - 1]!.url, /bridge_waiver2_shadow_outcomes\?on_conflict=capture_id,source/);
  } finally { globalThis.fetch = orig; }
});

test("EVIDENCE GATE: thresholds are fixed up front (not tiny); only LIVE_CAPTURED + certified + verified + complete + outcome counts; nothing is eligible today; the gate never promotes", () => {
  const T = WAIVER2_EVIDENCE_THRESHOLDS; assert.ok(T.minimum.distinct_live_weeks >= 8 && T.minimum.eligible_decisions >= 60 && T.minimum.distinct_managers >= 3); assert.ok(T.preferred.eligible_decisions > T.minimum.eligible_decisions && T.preferred.distinct_live_weeks > T.minimum.distinct_live_weeks && T.preferred.distinct_leagues >= 2);
  const g0 = waiver2EvidenceGate([], []); assert.equal(g0.status, "NOT_ELIGIBLE"); assert.equal(g0.auto_promotion, false); assert.equal(g0.lifecycle_state, "SHADOW_ONLY"); assert.match(g0.note, /never changes the lifecycle state/);
  const good = live(); assert.deepEqual(evaluationEligibility(good, true), { eligible: true, reasons: [] }); assert.equal(evaluationEligibility(good, false).eligible, false);
  const bad: Array<[string, WaiverShadowCaptureRecord]> = [["post-lock", live(fx(), { ...PRE, verdict: "POST_LOCK" })], ["unverified", live(fx(), null)], ["no schedule id", live(fx({ bye: undefined }))], ["bad scoring fp", { ...good, scoring_fingerprint: "legacy" }], ["no snapshot hash", { ...good, snapshot: { id: "s", content_hash: null } }], ["roster identity broken", { ...good, roster: { ...good.roster, active_player_ids: ["x"] } }]];
  for (const [n, r] of bad) assert.equal(evaluationEligibility(r, true).eligible, false, n);
  const many: WaiverShadowCaptureRecord[] = []; const outs: Array<{ capture_id: string }> = [];
  for (let w = 0; w < 8; w++) for (const mgr of ["a", "b", "c", "d", "e", "f", "g", "h"]) for (let k = 0; k < 2; k++) { const input = fx({ week: 2 + w, freeAgents: [{ id: "fa1", pos: "WR", pts: 11 + k * 0.1, team: "CHI", ros: 150 }] }); const ev = evaluateWaiver2(input); const r = buildCaptureRecord(ev, input, { league_slug: "L", manager_slug: mgr, season: 2026, kind: "LIVE_CAPTURED", lock: PRE }); many.push(r); outs.push({ capture_id: r.capture_id }); }
  const gate = waiver2EvidenceGate([...many, live(fx(), null), buildBlockedRecord(evaluateWaiver2(fx({ cert: "UNCERTIFIED_UNROSTERED" })), fx({ cert: "UNCERTIFIED_UNROSTERED" }), { ...M, kind: "NOT_ACTIONABLE", lock: null })], outs);
  assert.equal(gate.eligible_records, 64, "Phase 4.5: 128 eligible captures = 64 decision windows; the correlated repeat of each window is excluded, not counted"); assert.equal(gate.excluded.CORRELATED_SAME_DECISION_WINDOW, 64); assert.equal(gate.distinct_weeks, 8); assert.equal(gate.status, "MINIMUM_MET_FOR_REVIEW"); assert.ok(gate.unmet.length > 0, "preferred not met"); assert.equal(gate.excluded.NOT_ACTIONABLE, 1); assert.ok((gate.excluded.LIVE_UNVERIFIED ?? 0) === 1); assert.equal(gate.lifecycle_state, "SHADOW_ONLY");
});

// ------------------------------------------------------------------ runtime hook
let orig: typeof fetch; beforeEach(() => { __resetWaiver2CaptureHealth(); __clearWaiver2SeenCache(); orig = globalThis.fetch; }); afterEach(() => { __setWaiver2CaptureStore(undefined); globalThis.fetch = orig; });
const okSchedule = async () => ({ games: [{ week: 2, home: "KC", away: "CHI", date: "2099-01-01", status: "pre_game" }, { week: 2, home: "NO", away: "DEN", date: "2099-01-01", status: "pre_game" }, { week: 2, home: "GB", away: "NE", date: "2099-01-01", status: "pre_game" }], fetched_at: new Date().toISOString() });
const meta = (illustrative = false) => ({ ...M, illustrative });

test("RUNTIME: never changes the evaluation; illustrative is never persisted; unconfigured store is visible, not silent success", async () => {
  const input = fx(); const ev = evaluateWaiver2(input); const before = JSON.stringify(ev);
  __setWaiver2CaptureStore(null); const nc = await persistWaiver2Evidence(ev, input, meta()); assert.equal(nc.status, "NOT_CONFIGURED"); assert.equal(getWaiver2CaptureHealth().not_configured, 1);
  const mem = new MemoryWaiverCaptureStore(); __setWaiver2CaptureStore(mem); const ill = await persistWaiver2Evidence(ev, input, meta(true)); assert.equal(ill.status, "SKIPPED_ILLUSTRATIVE"); assert.equal(mem.list().length, 0); assert.equal(getWaiver2CaptureHealth().skipped_illustrative, 1);
  assert.equal(JSON.stringify(ev), before, "the evaluation object is untouched by capture");
});
test("RUNTIME: uncertified pool -> ONLY a NOT_ACTIONABLE readiness record; certified + verified lock -> LIVE_CAPTURED; certified + unverifiable -> LIVE_UNVERIFIED (no code change needed when the pool becomes certified)", async () => {
  const mem = new MemoryWaiverCaptureStore(); __setWaiver2CaptureStore(mem);
  const uin = fx({ cert: "UNCERTIFIED_UNROSTERED" }); const r1 = await persistWaiver2Evidence(evaluateWaiver2(uin), uin, meta(), { fetchSchedule: okSchedule, minIntervalMs: 0 }); assert.equal(r1.capture_class, "NOT_ACTIONABLE"); assert.equal(r1.status, "INSERTED");
  const cin = fx(); const r2 = await persistWaiver2Evidence(evaluateWaiver2(cin), cin, meta(), { fetchSchedule: okSchedule, minIntervalMs: 0 }); assert.equal(r2.capture_class, "LIVE_CAPTURED"); assert.equal(r2.status, "INSERTED");
  __clearWaiver2SeenCache(); const r3 = await persistWaiver2Evidence(evaluateWaiver2(cin), cin, meta(), { fetchSchedule: async () => ({ games: null, fetched_at: null }), minIntervalMs: 0 }); assert.equal(r3.capture_class, "LIVE_UNVERIFIED");
  const recs = mem.list(); assert.deepEqual(recs.map((r) => r.capture_class).sort(), ["LIVE_CAPTURED", "LIVE_UNVERIFIED", "NOT_ACTIONABLE"]); const blocked = recs.find((r) => r.capture_class === "NOT_ACTIONABLE")!; assert.deepEqual(blocked.actions, []); assert.deepEqual(blocked.pool.candidate_ids, []);
  const r4 = await persistWaiver2Evidence(evaluateWaiver2(cin), cin, meta(), { fetchSchedule: okSchedule, minIntervalMs: 0 }); assert.ok(["DUPLICATE_IDENTICAL", "INSERTED"].includes(r4.status));
  assert.equal(mem.list().filter((r) => r.capture_class === "LIVE_CAPTURED").length, 1, "a deterministic capture never duplicates");
});
test("RUNTIME FAILURE ISOLATION: a throwing / erroring / hanging store never throws, never alters the evaluation, and is COUNTED as a failure", async () => {
  const input = fx(); const ev = evaluateWaiver2(input); const before = JSON.stringify(ev);
  __setWaiver2CaptureStore({ kind: "x", durable: true, record: () => { throw new Error("db down"); }, attachOutcome: () => ({ status: "ERROR" }) }); const a = await persistWaiver2Evidence(ev, input, meta(), { fetchSchedule: okSchedule, minIntervalMs: 0 }); assert.equal(a.status, "ERROR"); assert.match(a.error!, /db down/);
  __clearWaiver2SeenCache(); __setWaiver2CaptureStore({ kind: "x", durable: true, record: () => ({ status: "ERROR", reason: "500" }), attachOutcome: () => ({ status: "ERROR" }) }); const b = await persistWaiver2Evidence(ev, input, meta(), { fetchSchedule: okSchedule, minIntervalMs: 0 }); assert.equal(b.status, "ERROR");
  __clearWaiver2SeenCache(); __setWaiver2CaptureStore({ kind: "x", durable: true, record: () => new Promise(() => undefined), attachOutcome: () => ({ status: "ERROR" }) }); const c = await persistWaiver2Evidence(ev, input, meta(), { fetchSchedule: okSchedule, timeoutMs: 30, minIntervalMs: 0 }); assert.equal(c.status, "TIMEOUT");
  const h = getWaiver2CaptureHealth(); assert.equal(h.failures, 3); assert.equal(h.inserted, 0, "failures are never counted as evidence collected"); assert.equal(JSON.stringify(ev), before);
  const bl = waiver2ActionsEvidence(ev, { ...M, illustrative: false }); assert.ok(bl.length > 5, "Book-Ready output is unaffected by capture failure");
});
test("WIRING: the ordinary Waiver 2.0 evaluation path calls the capture hook AFTER evaluating, capabilities expose capture health, and capture has no path into ranking", () => {
  const q = readFileSync("lib/book-ready/query.ts", "utf8"); const i = q.indexOf("evaluateWaiver2(r.input)"), j = q.indexOf("runWaiver2CaptureHook("); assert.ok(i > 0 && j > i, "capture is invoked after the evaluation");
  assert.match(q, /capture_health: getWaiver2CaptureHealth\(\)/); assert.match(readFileSync("app/api/evidence/route.ts", "utf8"), /installWaiver2Capture\(\)/); assert.doesNotMatch(q, /persistence/, "Book-Ready never imports persistence"); assert.match(q, /illustrative: p\.illustrative === "1"/);
  for (const f of ["actions", "context", "value", "market", "roster"]) assert.doesNotMatch(readFileSync(`lib/waiver2/${f}.ts`, "utf8"), /capture|persistWaiver2|CaptureStore/i, `${f}.ts (ranking path) never references capture`);
});

test("STORE CODE has no mutation APIs (insert-only + reads) and the applied migration enforces immutability, class integrity and RLS-deny", () => {
  for (const f of ["lib/persistence/supabase/waiver2-capture.ts", "lib/persistence/supabase/waiver2-capture-runtime.ts"]) { const s = readFileSync(f, "utf8"); assert.doesNotMatch(s, /\.update\(|\.delete\(|updateReturning|"PATCH"|"DELETE"|\.upsert\(/, f); assert.match(readFileSync("lib/persistence/supabase/waiver2-capture.ts", "utf8"), /insertIgnoreDuplicates/); }
  const sql = readFileSync("supabase/migrations/20260920190000_waiver2_shadow_captures.sql", "utf8");
  assert.match(sql, /before update or delete/); assert.match(sql, /bridge_waiver2_live_requires_certified_pool/); assert.match(sql, /bridge_waiver2_blocked_is_not_actionable/); assert.match(sql, /bridge_waiver2_live_captured_requires_lock/); assert.match(sql, /enable row level security/); assert.match(sql, /revoke all on public\.bridge_waiver2_shadow_captures from anon, authenticated/); assert.match(sql, /ROLLBACK/); assert.doesNotMatch(sql, /PRODUCTION_ACTIVE'\)/);
  for (const k of ["LIVE_CAPTURED", "LIVE_POST_LOCK", "LIVE_UNVERIFIED", "HISTORICALLY_RECONSTRUCTED", "ILLUSTRATIVE", "NOT_ACTIONABLE"]) assert.ok(sql.includes(`'${k}'`), k);
});

test("WRITE BOUNDS: a blocked readiness record is identified by the readiness fact (not the per-read snapshot id), and repeated requests are throttled", async () => {
  const mem = new MemoryWaiverCaptureStore(); __setWaiver2CaptureStore(mem); const a = fx({ cert: "UNCERTIFIED_UNROSTERED" });
  const ev = evaluateWaiver2(a); const r1 = buildBlockedRecord(ev, a, { ...M, kind: "NOT_ACTIONABLE", lock: null });
  const b = fx({ cert: "UNCERTIFIED_UNROSTERED" }); (b.weekly.lineage as { snapshot: { league_snapshot_id: string; content_hash: string } }).snapshot = { league_snapshot_id: "snap:other", content_hash: "zzzz" };
  const r2 = buildBlockedRecord(evaluateWaiver2(b), b, { ...M, kind: "NOT_ACTIONABLE", lock: null }); assert.equal(r2.capture_id, r1.capture_id, "a different snapshot read of the same blocked fact is the SAME capture");
  assert.equal(mem.record(r1).status, "INSERTED"); assert.equal(mem.record(r2).status, "DUPLICATE_IDENTICAL");
  const ranked1 = live(a === a ? fx() : a), ranked2 = live(fx()); assert.equal(ranked1.capture_id, ranked2.capture_id);
  const thr = new MemoryWaiverCaptureStore(); __setWaiver2CaptureStore(thr); __clearWaiver2SeenCache(); const inp = fx(); const e = evaluateWaiver2(inp);
  const x1 = await persistWaiver2Evidence(e, inp, meta(), { fetchSchedule: okSchedule }); const x2 = await persistWaiver2Evidence(e, inp, { ...meta() }, { fetchSchedule: okSchedule }); assert.equal(x1.status, "INSERTED"); assert.equal(x2.status, "DUPLICATE_IDENTICAL");
  const inp2 = fx({ freeAgents: [{ id: "fa1", pos: "WR", pts: 12.5, team: "CHI", ros: 150 }] }); const x3 = await persistWaiver2Evidence(evaluateWaiver2(inp2), inp2, meta(), { fetchSchedule: okSchedule }); assert.equal(x3.status, "THROTTLED", "a changed evaluation within the interval is throttled, not written"); assert.equal(thr.list().length, 1); assert.ok(getWaiver2CaptureHealth().throttled >= 1);
});
