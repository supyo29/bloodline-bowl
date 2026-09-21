/** Phase 5 Checkpoint G — prospective capture: classification, identity/dedupe, eligibility, gate, stores, cron auth. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildCaptureRecord, captureKindFor, classifyGameLock, evaluationEligibility, matchup2EvidenceGate, MATCHUP2_EVIDENCE_THRESHOLDS, MemoryMatchup2CaptureStore, validateCaptureRecord, type Baseline, type GameLock, type Matchup2CaptureRecord } from "@/lib/matchup2/capture";
import { buildMatchupContext } from "@/lib/matchup2/context";
import { evaluatePlayer } from "@/lib/matchup2/engine";
import type { MatchupEvaluation } from "@/lib/matchup2/contract";
import { SupabaseMatchup2CaptureStore, __resetMatchup2CaptureHealth, __setMatchup2CaptureStore, captureRow, getMatchup2CaptureHealth, persistMatchup2Capture } from "@/lib/persistence/supabase/matchup2-capture";
import { SupabaseRest } from "@/lib/persistence/supabase/rest";
import { mkSource } from "./fixtures/matchup2";

const src = mkSource({ players: [{ gsis: "wr", pos: "WR", epaMan: 0, epaZone: 0.3 }, { gsis: "rb", pos: "RB" }, { gsis: "qb", pos: "QB" }, { gsis: "te", pos: "TE" }] });
const ev = (id = "wr", def = "T20", fp: string | null = "scoring:v1:abc", week = 3): MatchupEvaluation => evaluatePlayer(src, buildMatchupContext(src, { offense_team: "T00", defense_team: def, week, scoring_fingerprint: fp }), id) as MatchupEvaluation;
const PRE: GameLock = { verdict: "PRE_KICKOFF_VERIFIED", reason: "OWN_GAME_PRE_GAME", team: "T00", game: { home: "T00", away: "T20", status: "pre_game", date: "2026-09-27" } };
const BASE: Baseline = { source: "sleeper-weekly-rotowire", model_version: "sleeper-weekly-rotowire", projected_points: 14.2, scoring_fingerprint: "scoring:v1:abc", injury_status: null, expected_availability: 1 };
const rec = (o: { e?: MatchupEvaluation; lock?: GameLock | null; baseline?: Baseline | null; at?: string; kind?: Matchup2CaptureRecordKind } = {}) => { const e = o.e ?? ev(); const lock = o.lock === undefined ? PRE : o.lock; const baseline = o.baseline === undefined ? BASE : o.baseline; return buildCaptureRecord(e, { kind: captureKindFor({ illustrative: false, is_reconstruction: false, lock, has_baseline: baseline != null }), baseline, lock, captured_at: o.at ?? "2026-09-22T14:15:00.000Z", invocation: "CRON" }); };
type Matchup2CaptureRecordKind = never;

test("lock: pristine ONLY when the player's OWN game is verifiably pre-game in a schedule read at decision time; no kickoff time is invented", () => {
  const T = "2026-09-22T14:15:00.000Z"; const g = (status: string, date = "2026-09-27") => [{ week: 3, home: "KC", away: "DEN", date, status }]; const c = (o: object) => classifyGameLock({ decision_timestamp: T, week: 3, team: "kc", games: g("pre_game"), schedule_fetched_at: T, ...o });
  assert.equal(c({}).verdict, "PRE_KICKOFF_VERIFIED"); assert.equal(c({ games: g("in_game") }).verdict, "POST_LOCK"); assert.equal(c({ games: g("complete") }).verdict, "POST_LOCK"); assert.equal(c({ games: g("pre_game", "2026-09-21") }).verdict, "POST_LOCK");
  assert.equal(c({ games: null, schedule_fetched_at: null }).verdict, "UNVERIFIED"); assert.equal(c({ schedule_fetched_at: "2026-09-22T12:00:00.000Z" }).verdict, "UNVERIFIED"); assert.equal(c({ team: "ZZZ" }).verdict, "UNVERIFIED"); assert.equal(c({ decision_timestamp: "bad" }).verdict, "UNVERIFIED");
  assert.equal(c({ games: [{ week: 4, home: "KC", away: "DEN", status: "pre_game" }] }).verdict, "UNVERIFIED", "a game in another week is not evidence");
});
test("class is DERIVED: pristine needs verified lock AND baseline; ILLUSTRATIVE is never built or persisted; reconstructed never counts", () => {
  assert.equal(rec().capture_class, "LIVE_CAPTURED"); assert.equal(rec({ lock: { ...PRE, verdict: "POST_LOCK", reason: "GAME_NOT_PRE_GAME:in_game" } }).capture_class, "LIVE_POST_LOCK"); assert.equal(rec({ lock: null }).capture_class, "LIVE_UNVERIFIED"); assert.equal(rec({ baseline: null }).capture_class, "LIVE_UNVERIFIED", "no baseline ⇒ never pristine");
  assert.throws(() => buildCaptureRecord(ev(), { kind: "ILLUSTRATIVE", baseline: BASE, lock: PRE, captured_at: "t" }), /never captured/);
  const recon = { ...rec(), capture_class: "HISTORICALLY_RECONSTRUCTED" as const }; assert.equal(evaluationEligibility(recon, true).eligible, false);
  const forged = { ...rec({ lock: null }), capture_class: "LIVE_CAPTURED" as const }; assert.match(validateCaptureRecord(forged).join(), /LIVE_CAPTURED requires/);
  assert.equal(rec().may_influence_production, false); assert.equal(rec().lifecycle_state, "SHADOW_ONLY");
});
test("record preserves every required identity: player, opponent, position, game, baseline, components, uncertainty, evidence versions, scoring fingerprint, lock, model version", () => {
  const r = rec(); const has = (o: object, ...ks: string[]) => ks.forEach((k) => assert.ok(k in o, k)); has(r, "player", "opponent", "season", "week", "model_version", "context_identity", "evidence_identities", "scoring_fingerprint", "baseline", "components", "structural_verdict", "uncertainty_kinds", "lock", "capture_class");
  assert.equal(r.player.position, "WR"); assert.equal(r.scoring_fingerprint, "scoring:v1:abc"); assert.deepEqual(r.evidence_identities, { fi: "fi-test", role: "roi-test", player_scheme: "psi-test", opp: null }); assert.ok(r.components.length >= 5); assert.ok(!r.components.some((c) => c.id === "coverage.game_expectation"), "the modeled baseline-only expectation is not decision evidence"); assert.deepEqual(validateCaptureRecord(r), []);
});
test("DEDUPE: identical requests, read timestamps, provenance and schedule-read time share ONE identity; a real decision change creates a new one", () => {
  const a = rec(); assert.equal(rec({ at: "2026-09-23T09:00:00.000Z" }).capture_id, a.capture_id, "timestamp movement alone never creates a row");
  assert.equal(buildCaptureRecord(ev(), { kind: "LIVE_CAPTURED", baseline: BASE, lock: PRE, captured_at: "x", invocation: "REQUEST" }).capture_id, a.capture_id, "invocation origin is not identity");
  const ids = new Set([a.capture_id]); const add = (r: Matchup2CaptureRecord) => ids.add(r.capture_id);
  add(rec({ e: ev("wr", "T21") })); add(rec({ e: ev("wr", "T20", "scoring:v1:zzz") })); add(rec({ e: ev("rb") })); add(rec({ e: ev("wr", "T20", "scoring:v1:abc", 4) }));
  add(rec({ baseline: { ...BASE, projected_points: 15.5 } })); add(rec({ baseline: { ...BASE, model_version: "other-model" } })); add(rec({ lock: { ...PRE, verdict: "POST_LOCK", reason: "GAME_NOT_PRE_GAME:in_game" } }));
  const s2 = mkSource({ players: [{ gsis: "wr", pos: "WR", epaMan: 0.3, epaZone: 0 }] }); add(rec({ e: evaluatePlayer(s2, buildMatchupContext(s2, { offense_team: "T00", defense_team: "T20", week: 3, scoring_fingerprint: "scoring:v1:abc" }), "wr") as MatchupEvaluation }));
  const s3 = mkSource({ players: [{ gsis: "wr", pos: "WR", epaMan: 0, epaZone: 0.3 }], vintages: [{ source: "football-intelligence", version: "fi:NEW", season: 2026, through_week: 3, availability: "LIVE_CURRENT" }] }); add(rec({ e: evaluatePlayer(s3, buildMatchupContext(s3, { offense_team: "T00", defense_team: "T20", week: 3, scoring_fingerprint: "scoring:v1:abc" }), "wr") as MatchupEvaluation }));
  assert.equal(ids.size, 10);
});
test("eligibility + gate: thresholds fixed and unchanged; only pristine, complete, outcome-bearing records count; ONE decision per player-week-scoring; nothing auto-promotes", () => {
  const T = MATCHUP2_EVIDENCE_THRESHOLDS; assert.deepEqual(T.minimum, { distinct_live_weeks: 8, eligible_decisions: 300, distinct_players: 100, positions_covered: 4 }); assert.ok(T.preferred.eligible_decisions > T.minimum.eligible_decisions);
  const good = rec(); assert.deepEqual(evaluationEligibility(good, true), { eligible: true, reasons: [] }); assert.match(evaluationEligibility(good, false).reasons.join(), /no outcome/);
  for (const [n, r] of [["post-lock", rec({ lock: { ...PRE, verdict: "POST_LOCK", reason: "x" } })], ["no baseline", rec({ baseline: null })], ["bad fp", rec({ e: ev("wr", "T20", "legacy") })], ["unverified", rec({ lock: null })]] as const) assert.equal(evaluationEligibility(r, true).eligible, false, n);
  const records: Matchup2CaptureRecord[] = []; const outs: Array<{ capture_id: string }> = [];
  for (let w = 1; w <= 8; w++) for (const id of ["wr", "rb", "qb", "te"]) for (let k = 0; k < 30; k++) { const r = rec({ e: ev(id, "T20", "scoring:v1:abc", w), baseline: { ...BASE, projected_points: 10 + k * 0.1 }, at: `2026-09-${String(10 + (k % 9)).padStart(2, "0")}T14:00:00.000Z` }); r.player.gsis_id = `${id}-${k % 25}`; records.push({ ...r, capture_id: `${r.capture_id}${k}`, content_hash: r.content_hash }); outs.push({ capture_id: `${r.capture_id}${k}` }); }
  const g0 = matchup2EvidenceGate([], []); assert.equal(g0.status, "NOT_ELIGIBLE"); assert.equal(g0.auto_promotion, false); assert.match(g0.note, /HUMAN REVIEW only/);
  const g = matchup2EvidenceGate(records, outs); assert.equal(g.status, "NOT_ELIGIBLE", "records with tampered ids fail validation and do not count"); assert.ok((g.excluded.FAILS_ELIGIBILITY ?? 0) > 0);
  // valid, distinct decisions across 8 weeks × 100 players × 4 positions
  const valid: Matchup2CaptureRecord[] = []; for (let w = 1; w <= 8; w++) for (let p = 0; p < 100; p++) { const pos = ["wr", "rb", "qb", "te"][p % 4]!; const r = rec({ e: ev(pos, "T20", "scoring:v1:abc", w), at: `2026-09-1${w}T14:00:00.000Z` }); const m = { ...r, player: { ...r.player, gsis_id: `${pos}-${p}` } }; const { capture_id, content_hash, captured_at, ...b } = m; void capture_id; void content_hash; void captured_at; valid.push(buildCaptureRecord({ ...ev(pos, "T20", "scoring:v1:abc", w), offense_subject: { ...ev(pos).offense_subject, id: `${pos}-${p}` } } as MatchupEvaluation, { kind: "LIVE_CAPTURED", baseline: BASE, lock: PRE, captured_at: m.captured_at })); void b; }
  const vo = valid.map((r) => ({ capture_id: r.capture_id })); const gv = matchup2EvidenceGate(valid, vo); assert.equal(gv.eligible_decisions, 800); assert.equal(gv.status, "MINIMUM_MET_FOR_REVIEW"); assert.equal(gv.positions_covered, 4);
  const later = valid.slice(0, 40).map((r, i) => buildCaptureRecord({ ...ev(["wr", "rb", "qb", "te"][i % 4]!, "T20", "scoring:v1:abc", r.week), offense_subject: { ...ev("wr").offense_subject, id: r.player.gsis_id, position: r.player.position as "WR" } } as MatchupEvaluation, { kind: "LIVE_CAPTURED", baseline: { ...BASE, projected_points: 99 }, lock: PRE, captured_at: "2026-09-30T00:00:00.000Z" }));
  const gd = matchup2EvidenceGate([...valid, ...later], [...vo, ...later.map((r) => ({ capture_id: r.capture_id }))]); assert.equal(gd.eligible_decisions, 800, "later correlated captures of the same player-week never add decisions"); assert.equal(gd.excluded.CORRELATED_SAME_DECISION_WINDOW, 40);
});
test("memory + durable stores: insert-only, idempotent, tamper-evident, orphan outcome refused; mocked PostgREST shape; runtime degrades truthfully", async () => {
  const s = new MemoryMatchup2CaptureStore(); const r = rec(); assert.equal(s.record(r).status, "INSERTED"); assert.equal(s.record(r).status, "DUPLICATE_IDENTICAL"); assert.equal(s.record({ ...r, week: 9 }).status, "REFUSED");
  assert.equal(s.attachOutcome({ capture_id: r.capture_id, source: "x", recorded_at: "t", realized_fantasy_points: 12, played: true }).status, "INSERTED"); assert.equal(s.attachOutcome({ capture_id: "m2cap:nope", source: "x", recorded_at: "t", realized_fantasy_points: 1, played: true }).status, "REFUSED");
  const calls: Array<{ url: string; body: unknown }> = []; const orig = globalThis.fetch; let dup = false;
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url: String(url), body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify(dup ? [] : [{ capture_id: "x" }]), { status: 201, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try { const d = new SupabaseMatchup2CaptureStore(new SupabaseRest({ url: "https://x.supabase.co", serviceRoleKey: "k" })); assert.equal((await d.record(r)).status, "INSERTED"); assert.match(calls[0]!.url, /bridge_matchup2_shadow_captures\?on_conflict=capture_id/); const row = (calls[0]!.body as Array<Record<string, unknown>>)[0]!; assert.deepEqual(Object.keys(row).sort(), Object.keys(captureRow(r)).sort()); assert.equal(row.has_baseline, true); assert.equal(row.lock_verdict, "PRE_KICKOFF_VERIFIED");
    dup = true; assert.equal((await d.record(r)).status, "DUPLICATE_IDENTICAL"); const n = calls.length; assert.equal((await d.record({ ...r, week: 99 })).status, "REFUSED"); assert.equal(calls.length, n, "an invalid record never reaches the network"); } finally { globalThis.fetch = orig; }
  __resetMatchup2CaptureHealth(); __setMatchup2CaptureStore(undefined); __setMatchup2CaptureStore(null); assert.equal(await persistMatchup2Capture(r), "NOT_CONFIGURED");
  const mem = new MemoryMatchup2CaptureStore(); __setMatchup2CaptureStore(mem); assert.equal(await persistMatchup2Capture(r), "INSERTED"); assert.equal(await persistMatchup2Capture(r), "DUPLICATE_IDENTICAL"); assert.equal(getMatchup2CaptureHealth().inserted, 1); assert.equal(getMatchup2CaptureHealth().by_class.LIVE_CAPTURED, 1);
  __setMatchup2CaptureStore({ kind: "boom", durable: true, record: () => { throw new Error("db down"); }, attachOutcome: () => { throw new Error("x"); } }); assert.equal(await persistMatchup2Capture(rec({ e: ev("rb") })), "ERROR"); assert.equal(getMatchup2CaptureHealth().failures, 1);
  __setMatchup2CaptureStore({ kind: "slow", durable: true, record: () => new Promise(() => undefined), attachOutcome: () => new Promise(() => undefined) });
});
beforeEach(() => { __resetMatchup2CaptureHealth(); __setMatchup2CaptureStore(undefined); });
test("CRON /api/cron/matchup2-capture is auth-gated and scheduled; public evidence topics have no baseline and no capture path", async () => {
  const { GET } = (await import("../app/api/cron/matchup2-capture/route")) as { GET: (r: Request) => Promise<Response> }; const saved = process.env.CRON_SECRET; delete process.env.CRON_SECRET;
  try { const none = await GET(new Request("https://x/api/cron/matchup2-capture")); assert.ok([401, 403, 503].includes(none.status)); process.env.CRON_SECRET = "s3cret"; assert.equal((await GET(new Request("https://x/api/cron/matchup2-capture", { headers: { authorization: "Bearer nope" } }))).status, 401); } finally { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; }
  const { readFileSync, readdirSync, statSync } = await import("node:fs"); const { join } = await import("node:path"); assert.ok(JSON.parse(readFileSync("vercel.json", "utf8")).crons.some((c: { path: string }) => c.path === "/api/cron/matchup2-capture"));
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : []; });
  const writers = [...walk("app"), ...walk("lib")].filter((f) => /persistMatchup2Capture|runScheduledMatchup2Capture/.test(readFileSync(f, "utf8")) && !f.startsWith("lib/persistence/supabase/matchup2-capture") && !f.startsWith("test/")); assert.deepEqual(writers, ["app/api/cron/matchup2-capture/route.ts"], "the cron route is the ONLY writer; book-ready/evidence routes cannot create records");
});
