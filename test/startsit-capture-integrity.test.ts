/**
 * Phase 3.5A Checkpoint C -- shadow-capture evidence integrity + deployment isolation.
 * Adversarial matrix items 11-25.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  MemoryShadowCaptureStore, NullCaptureStore, setShadowCaptureStore, getShadowCaptureStore,
  buildShadowDecisionRecord, persistShadowDecision, persistShadowRecord, classifyLock, getCaptureHealth,
  summarizeCaptures, withOutcome, captureShadowDecision, isValidLiveEvidence, loadStartSitModel, __resetStartSitModelCache,
  fiMayInfluenceProduction, anyFiProductionInfluence, deploymentContract,
  type StartSitShadowComparison, type ShadowCaptureStore, type ShadowDecisionRecord,
} from "@/lib/weekly/start-sit-fi";
import { __resetCaptureHealth } from "@/lib/weekly/start-sit-fi/capture";
import { SupabaseShadowCaptureStore, captureRow } from "@/lib/persistence/supabase/shadow-capture";
import { SupabaseRest } from "@/lib/persistence/supabase/rest";
import type { RawNflScheduleGame } from "@/lib/canonical/nfl-reality-frontier";

const T0 = "2026-09-20T15:00:00.000Z"; // Sunday 11:00 ET
const cmp = (over: { ts?: string; model?: string; fi?: string; proj?: number } = {}): StartSitShadowComparison => ({
  lineage: {
    start_sit_model_version: over.model ?? "ri-startsit-2026.1", football_intelligence_version: over.fi ?? "fi:2026:w02:aaa",
    football_intel_data_cutoff: { pbp: 2 }, baseline_projection_version: "ri-structural-2026.3",
    decision_generated_at: over.ts ?? T0, deployment: "SHADOW_ONLY", contract_version: "start-sit-fi-2026.1",
  },
  production_recommendation_lineage: {} as never,
  shadow_football_intelligence: { lineage: null, readiness: {} as never, eligible_to_influence_production: false },
  adjustments: [
    { canonical_player_id: "p1", position: "RB", nfl_team: "KC", opponent: "DEN", baseline_projection: over.proj ?? 12, raw_expected_adjustment: 0.1, expected_adjustment: 0.1, floor_adjustment: 0, ceiling_adjustment: 0, adjusted_projection: 12.1, decision_confidence: "MEDIUM", contributions: [], reason_codes: ["FI_SHADOW_ONLY"], warnings: [], fi_prior_season_only: false, fi_available: true },
    { canonical_player_id: "p2", position: "RB", nfl_team: "LV", opponent: "LAC", baseline_projection: 11.5, raw_expected_adjustment: 0.6, expected_adjustment: 0.6, floor_adjustment: 0, ceiling_adjustment: 0, adjusted_projection: 12.1, decision_confidence: "MEDIUM", contributions: [], reason_codes: ["FI_SHADOW_ONLY"], warnings: [], fi_prior_season_only: false, fi_available: true },
  ],
  baseline_lineup_total: 100, fi_lineup_total: 100, lineup_differs: true, lineup_deltas: [],
  start_sit_deltas: [{ slot: "FLEX", baseline_start: "p1", fi_start: "p2", baseline_edge: 0.5, fi_edge: -0.2, changed: true, inside_tie_break_gate: true, reason_codes: ["BASELINE_PROJECTION_EDGE"] }],
  notes: [],
} as unknown as StartSitShadowComparison);

const game = (home: string, away: string, status: string, date: string): RawNflScheduleGame => ({ week: 2, home, away, status, date, game_id: `${home}${away}` });
const preGames = [game("KC", "DEN", "pre_game", "2026-09-20"), game("LV", "LAC", "pre_game", "2026-09-20")];
const lock = (over: Partial<Parameters<typeof classifyLock>[0]> = {}) =>
  classifyLock({ decision_timestamp: T0, week: 2, involved_teams: ["KC", "DEN", "LV", "LAC"], games: preGames, schedule_fetched_at: T0, ...over });
const rec = (o: Parameters<typeof cmp>[0] = {}, meta: Partial<Parameters<typeof buildShadowDecisionRecord>[1]> = {}) =>
  buildShadowDecisionRecord(cmp(o), { season: 2026, week: 2, league_slug: "bloodline-bowl", manager_slug: "m1", scoring_fingerprint: "scoring:v1:abc", lock_evidence: lock(), ...meta });

const savedCtx = process.env.NODE_TEST_CONTEXT;
beforeEach(() => { setShadowCaptureStore(null); __resetCaptureHealth(); });
afterEach(() => { setShadowCaptureStore(null); if (savedCtx === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = savedCtx; });

/* ---------------- 11. unwired store is never a successful capture ---------------- */
test("11: an unwired/default store cannot be mistaken for durable capture", async () => {
  delete process.env.NODE_TEST_CONTEXT; // outside `node --test`, no resolver installed
  const s = getShadowCaptureStore();
  assert.equal(s.kind, "unconfigured"); assert.equal(s.durable, false);
  const r = await persistShadowRecord(rec());
  assert.equal(r.status, "NOT_CONFIGURED"); assert.equal(r.durable, false);
  setShadowCaptureStore(new NullCaptureStore());
  const n = await persistShadowRecord(rec());
  assert.equal(n.status, "NOT_CAPTURED_NULL_STORE");
  const h = getCaptureHealth();
  assert.equal(h.created, 0); assert.equal(h.not_captured, 2); assert.ok(h.last_error);
});

/* ---------------- 12. idempotency ---------------- */
test("12: repeated identical requests are idempotent (new timestamp, same decision)", async () => {
  const store = new MemoryShadowCaptureStore(); setShadowCaptureStore(store);
  const a = rec({ ts: T0 }); const b = rec({ ts: "2026-09-20T15:00:07.000Z" });
  assert.equal(a.capture_id, b.capture_id);
  assert.equal((await persistShadowRecord(a)).status, "CREATED");
  assert.equal((await persistShadowRecord(b)).status, "DUPLICATE");
  assert.equal(store.records.size, 1);
  // a materially different decision (projection moved) is a NEW record, not a duplicate
  assert.notEqual(rec({ proj: 12.4 }).capture_id, a.capture_id);
});

/* ---------------- 13/14. pre-kickoff integrity ---------------- */
test("13: genuine pre-kickoff request becomes LIVE_CAPTURED with lock evidence", () => {
  const r = rec();
  assert.equal(r.capture_kind, "LIVE_CAPTURED"); assert.ok(isValidLiveEvidence(r.capture_kind));
  assert.equal(r.lock_evidence?.verdict, "PRE_KICKOFF_VERIFIED");
  assert.deepEqual(r.lock_evidence?.games.map((g) => g.status), ["pre_game", "pre_game", "pre_game", "pre_game"].slice(0, r.lock_evidence!.games.length));
});

test("14: post-kickoff / unverifiable requests can never masquerade as pristine LIVE_CAPTURED", () => {
  for (const status of ["in_game", "complete", "postponed", "weird"]) {
    const k = lock({ games: [game("KC", "DEN", status, "2026-09-20"), game("LV", "LAC", "pre_game", "2026-09-20")] });
    assert.equal(k.kind, "LIVE_POST_LOCK", status); assert.equal(isValidLiveEvidence(k.kind), false);
  }
  // status lagging: still 'pre_game' but the game's date is already past in ET
  assert.equal(lock({ decision_timestamp: "2026-09-21T16:00:00.000Z", schedule_fetched_at: "2026-09-21T16:00:00.000Z" }).kind, "LIVE_POST_LOCK");
  // schedule missing, stale, or no involved game -> UNVERIFIED (fail closed)
  assert.equal(lock({ games: null, schedule_fetched_at: null }).kind, "LIVE_UNVERIFIED");
  assert.equal(lock({ schedule_fetched_at: "2026-09-20T14:00:00.000Z" }).kind, "LIVE_UNVERIFIED");
  assert.equal(lock({ games: [game("NYG", "DAL", "pre_game", "2026-09-20")] }).kind, "LIVE_UNVERIFIED");
  assert.equal(lock({ decision_timestamp: "garbage" }).kind, "LIVE_UNVERIFIED");
  // a bare request claiming LIVE_CAPTURED without evidence is downgraded; evidence overrides the claim
  const bare = buildShadowDecisionRecord(cmp(), { season: 2026, week: 2, league_slug: "l", manager_slug: "m", scoring_fingerprint: null, kind: "LIVE_CAPTURED" });
  assert.equal(bare.capture_kind, "LIVE_UNVERIFIED");
  const post = buildShadowDecisionRecord(cmp(), { season: 2026, week: 2, league_slug: "l", manager_slug: "m", scoring_fingerprint: null, kind: "LIVE_CAPTURED", lock_evidence: lock({ games: [game("KC", "DEN", "complete", "2026-09-20")] }) });
  assert.equal(post.capture_kind, "LIVE_POST_LOCK");
  // the legacy entry point cannot default to LIVE_CAPTURED either
  setShadowCaptureStore(new MemoryShadowCaptureStore());
  assert.equal(captureShadowDecision(cmp(), { season: 2026, week: 2, league_slug: "l", manager_slug: "m", scoring_fingerprint: null }).capture_kind, "LIVE_UNVERIFIED");
});

/* ---------------- 15. reconstruction stays labelled + separate ---------------- */
test("15: reconstructed evidence is labelled, never collides with live, and is counted separately", async () => {
  const store = new MemoryShadowCaptureStore(); setShadowCaptureStore(store);
  const live = rec();
  const recon = rec({}, { kind: "HISTORICALLY_RECONSTRUCTED", lock_evidence: undefined });
  assert.equal(recon.capture_kind, "HISTORICALLY_RECONSTRUCTED");
  assert.notEqual(recon.capture_id, live.capture_id); // same numbers, different class => different record
  await persistShadowRecord(live); await persistShadowRecord(recon);
  const s = await store.summary();
  assert.deepEqual(s.totals_by_kind, { LIVE_CAPTURED: 1, HISTORICALLY_RECONSTRUCTED: 1 });
  assert.deepEqual(s.live_captured_by_week, { "2": 1 }); // reconstructed never leaks into the live-by-week count
  assert.equal(Object.keys(s.by_position).length, 1);
  assert.equal(s.by_position.RB!.decisions, 1); assert.equal(s.by_position.RB!.reversals, 1); // valid live only
});

/* ---------------- 16. immutability + enrichment ---------------- */
test("16: outcome enrichment never mutates the original decision evidence", async () => {
  const store = new MemoryShadowCaptureStore(); setShadowCaptureStore(store);
  const r = rec(); await persistShadowRecord(r);
  const before = JSON.stringify(store.records.get(r.capture_id!));
  assert.throws(() => { (r as { capture_kind: string }).capture_kind = "LIVE_POST_LOCK"; }, TypeError);
  assert.throws(() => { (r.adjustments[0] as { baseline_projection: number }).baseline_projection = 99; }, TypeError);
  assert.throws(() => { (r as { actual_fantasy_points: unknown }).actual_fantasy_points = { p1: 20 }; }, TypeError);
  const o = { capture_id: r.capture_id!, source: "sleeper-stats", recorded_at: "2026-09-22T00:00:00Z", scoring_fingerprint: "scoring:v1:abc", actual_fantasy_points: { p1: 20, p2: 9 } };
  assert.equal((await store.recordOutcome(o)).status, "CREATED");
  assert.equal((await store.recordOutcome(o)).status, "DUPLICATE");
  assert.equal(JSON.stringify(store.records.get(r.capture_id!)), before);
  assert.equal(store.records.get(r.capture_id!)!.actual_fantasy_points, null);
  assert.equal(withOutcome(r, o).decision, r);
  assert.throws(() => withOutcome(r, { ...o, capture_id: "ssc:other" }));
  assert.equal((await store.recordOutcome({ ...o, capture_id: "ssc:missing" })).status, "ERROR");
});

/* ---------------- 17. failure isolation + visibility ---------------- */
test("17: persistence failure/timeout never throws, is visible, and never changes the decision", async () => {
  const boom: ShadowCaptureStore = { kind: "boom", durable: true, record: () => { throw new Error("db down"); } };
  const slow: ShadowCaptureStore = { kind: "slow", durable: true, record: () => new Promise(() => undefined) };
  const c = cmp(); const snapshot = JSON.stringify(c);
  setShadowCaptureStore(boom);
  const a = await persistShadowDecision(c, { season: 2026, week: 2, league_slug: "l", manager_slug: "m", scoring_fingerprint: null, lock_evidence: lock() });
  assert.equal(a.result.status, "ERROR"); assert.match(a.result.error!, /db down/);
  setShadowCaptureStore(slow);
  const b = await persistShadowDecision(c, { season: 2026, week: 2, league_slug: "l", manager_slug: "m", scoring_fingerprint: null, lock_evidence: lock() }, 30);
  assert.equal(b.result.status, "TIMEOUT");
  assert.equal(JSON.stringify(c), snapshot, "the comparison (recommendation input) is untouched");
  const h = getCaptureHealth(); assert.equal(h.failures, 2); assert.equal(h.created, 0); assert.ok(h.last_error);
  // a record that cannot even be built is reported, not thrown
  const bad = await persistShadowDecision({} as never, { season: 2026, week: 2, league_slug: "l", manager_slug: "m", scoring_fingerprint: null });
  assert.equal(bad.result.status, "ERROR");
});

test("17b: the runtime capture block runs after production output and does not null the shadow on failure", () => {
  const src = readFileSync(join(process.cwd(), "lib", "weekly", "intelligence.ts"), "utf8");
  const iCap = src.indexOf("persistShadowDecision(start_sit_shadow");
  assert.ok(src.indexOf("buildCloseCalls(ctx, lineup)") < iCap && src.indexOf("buildWaiverRecommendations(ctx)") < iCap);
  const catchBlock = src.slice(iCap, src.indexOf("// Phase 5 shadow path"));
  assert.ok(!/start_sit_shadow\s*=\s*null/.test(catchBlock), "capture failure must not discard the shadow comparison");
  assert.ok(/console\.warn/.test(catchBlock), "capture failure must be logged, not swallowed");
});

/* ---------------- 18-20. evidence separation ---------------- */
test("18-20: model, FI, scoring, league and manager differences are separate evidence", async () => {
  const store = new MemoryShadowCaptureStore(); setShadowCaptureStore(store);
  const base = rec();
  const variants = [
    rec({ model: "ri-startsit-2026.2" }), rec({ fi: "fi:2026:w03:bbb" }),
    rec({}, { scoring_fingerprint: "scoring:v1:xyz" }), rec({}, { league_slug: "devoted-to-the-game" }), rec({}, { manager_slug: "m2" }),
  ];
  const ids = new Set([base, ...variants].map((r) => r.capture_id));
  assert.equal(ids.size, 6);
  for (const r of [base, ...variants]) assert.equal((await persistShadowRecord(r)).status, "CREATED");
  assert.equal(store.records.size, 6);
  const s = summarizeCaptures([...store.records.values()], 0, "memory", false);
  assert.equal(Object.keys(s.by_model_version).length, 2); assert.equal(Object.keys(s.by_scoring_fingerprint).length, 2);
});

/* ---------------- Supabase store contract (PostgREST stubbed) ---------------- */
test("supabase store: idempotency is the DB conflict target; row is the immutable record; errors are results", async () => {
  const calls: Array<{ url: string; method: string; prefer?: string; body?: string }> = [];
  const origFetch = globalThis.fetch;
  let mode: "created" | "dup" | "500" = "created";
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: init.method ?? "GET", prefer: (init.headers as Record<string, string>).Prefer, body: init.body as string });
    if (mode === "500") return new Response(JSON.stringify({ code: "XX000" }), { status: 500 });
    return new Response(JSON.stringify(mode === "created" ? [{ capture_id: "x" }] : []), { status: 201 });
  }) as typeof fetch;
  try {
    const store = new SupabaseShadowCaptureStore(new SupabaseRest({ url: "https://x.supabase.co", serviceRoleKey: "k" }));
    assert.equal(store.durable, true);
    const r = rec();
    assert.equal((await store.record(r)).status, "CREATED");
    assert.match(calls[0]!.url, /bridge_startsit_shadow_captures\?on_conflict=capture_id/);
    assert.match(calls[0]!.prefer!, /resolution=ignore-duplicates/);
    const row = JSON.parse(calls[0]!.body!)[0];
    assert.equal(row.capture_id, r.capture_id); assert.equal(row.capture_kind, "LIVE_CAPTURED"); assert.equal(row.lock_verdict, "PRE_KICKOFF_VERIFIED");
    assert.equal(row.record.capture_id, r.capture_id);
    mode = "dup"; assert.equal((await store.record(r)).status, "DUPLICATE");
    mode = "500"; const e = await store.record(r); assert.equal(e.status, "ERROR"); assert.doesNotMatch(e.error ?? "", /"k"|serviceRole/);
    // a legacy (v1) record has no identity and is refused, never half-written
    const legacy = { ...r, capture_id: undefined, content_hash: undefined } as unknown as ShadowDecisionRecord;
    assert.equal((await store.record(legacy)).status, "ERROR");
    assert.equal(captureRow(r).record, r);
  } finally { globalThis.fetch = origFetch; }
});

/* ---------------- 21-25. deployment isolation ---------------- */
const walk = (dir: string): string[] => readdirSync(dir).flatMap((e) => { const p = join(dir, e); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
const ROOT = process.cwd();

test("21: ri-startsit-2026.1 is immutable (artifact hash + version + coefficients pinned)", () => {
  const raw = readFileSync(join(ROOT, "lib", "weekly", "data", "start_sit_model.json"));
  assert.equal(createHash("sha256").update(raw).digest("hex"), "85d2ddd501cc10d5b3a699629f80c0c3781fe12fa24fa834f41969cb0186b293");
  __resetStartSitModelCache(); const m = loadStartSitModel(true)!;
  assert.equal(m.start_sit_model_version, "ri-startsit-2026.1"); assert.equal(m.tau_tie_break, 3);
});

test("22: every position remains non-production-active", () => {
  __resetStartSitModelCache(); const m = loadStartSitModel(true)!;
  for (const p of ["QB", "RB", "WR", "TE", "K", "DEF"]) assert.equal(fiMayInfluenceProduction(m, p), false, p);
  assert.equal(anyFiProductionInfluence(m), false);
  assert.equal(deploymentContract(m).deployment, "SHADOW_ONLY");
});

test("23-24: only the shadow builder/capture layer consumes Start/Sit FI numbers -- no waiver/trade/matchup/lineup path", () => {
  const allowedImporters = new Set([
    "lib/weekly/intelligence.ts", "lib/canonical/recommendation-readiness.ts", "lib/canonical/intelligence-freshness.ts",
    "lib/orchestrator/schema.ts", "lib/persistence/supabase/shadow-capture.ts",
    "app/api/football-intel/startsit-evidence/route.ts",
  ]);
  const offenders: string[] = [];
  for (const dir of ["lib", "app"]) for (const f of walk(join(ROOT, dir))) {
    const rel = f.slice(ROOT.length + 1);
    if (rel.startsWith("lib/weekly/start-sit-fi/")) continue;
    const src = readFileSync(f, "utf8");
    if (/start-sit-fi/.test(src) && !allowedImporters.has(rel)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], "unexpected consumers of the Start/Sit FI layer");
  // production engines never reference FI adjustment fields
  for (const f of ["lineup", "start-sit", "waivers", "matchup", "ros", "replacement", "summary", "decision-score"]) {
    const src = readFileSync(join(ROOT, "lib", "weekly", `${f}.ts`), "utf8");
    assert.ok(!/expected_adjustment|adjusted_projection|start_sit_shadow|fi_start/.test(src), `${f}.ts touches FI adjustment fields`);
  }
});

test("25: no research verdict / R script writes an activation or promotes deployment state", () => {
  for (const f of ["eligibility.R", "evidence_gate.R", "reevaluate.R", "train.R", "backtest.R"]) {
    const src = readFileSync(join(ROOT, "analysis", "football_intel_startsit", f), "utf8");
    assert.ok(!/activation_log\s*(<-|=)/.test(src), `${f} writes activation_log`);
    assert.ok(!/deployment_contract\s*\$\s*positions\s*(\[\[.*\]\]|\$\w+)\s*<-/.test(src), `${f} edits deployment positions`);
    assert.ok(!/"PRODUCTION_ACTIVE"\s*[,)]?\s*$/m.test(src.replace(/#.*$/gm, "")) || f === "x", `${f} assigns PRODUCTION_ACTIVE`);
  }
});
