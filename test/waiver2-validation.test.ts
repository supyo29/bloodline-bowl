/** Phase 4 (Checkpoint G) — evaluation suite defined first, evidence classification honest, prospective capture immutable and class-separated. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateWaiver2 } from "@/lib/waiver2";
import { buildCaptureRecord, captureKindFor, MemoryWaiverCaptureStore, waiver2EvidenceGate, WAIVER2_EVIDENCE_MIN_WEEKS, type WaiverOutcome } from "@/lib/waiver2/capture";
import { auditHistoricalEvidence, scoreDecisions, METRIC_DEFINITIONS, type DecisionOutcome } from "@/lib/waiver2/evaluation";
import { mkWaiverInput, stdMine } from "./fixtures/waiver2";

const OTHERS = [{ id: "3", players: [{ id: "o1", pos: "WR" as const, pts: 9, team: "GB" }, { id: "o3", pos: "RB" as const, pts: 12, team: "GB" }] }];
const fx = (over = {}) => mkWaiverInput({ mine: stdMine(), others: OTHERS, freeAgents: [{ id: "fa1", pos: "WR", pts: 11, team: "CHI", ros: 150 }], ...over });
const M = { league_slug: "bloodline-bowl", manager_slug: "supyo29", season: 2026 };
const cap = (kind: "LIVE_CAPTURED" | "LIVE_POST_LOCK" | "LIVE_UNVERIFIED" | "HISTORICALLY_RECONSTRUCTED", input = fx()) => buildCaptureRecord(evaluateWaiver2(input), input, { ...M, kind });

test("the evaluation suite is DEFINED before any fitting: every spec §28 target has a named definition, and nothing here fits a parameter", () => {
  for (const k of ["net_roster_value", "starter_improvement", "replacement_value_gain", "breakout_identification", "false_breakout_avoidance", "drop_regret", "faab_efficiency", "opportunity_per_faab", "alternative_regret"]) assert.ok(METRIC_DEFINITIONS[k] && METRIC_DEFINITIONS[k]!.length > 15, k);
  assert.doesNotMatch(readFileSync("lib/waiver2/evaluation.ts", "utf8"), /optimi[sz]e|gradient|fit\(|regress|tune\(/i, "the suite scores; it does not fit");
});
test("HISTORICAL HONESTY: no pool history exists — alternatives are UNSAFE_FOR_BACKTEST, claims RETROSPECTIVE_ONLY, and TRUE_AS_OF only comes from live captures", () => {
  const a = auditHistoricalEvidence(); const by = (s: string) => a.find((x) => x.input.startsWith(s))!;
  assert.equal(by("free-agent pool").class, "UNSAFE_FOR_BACKTEST"); assert.equal(by("candidate ranking").class, "UNSAFE_FOR_BACKTEST"); assert.equal(by("realized claims").class, "RETROSPECTIVE_ONLY"); assert.equal(by("manager roster").class, "RECONSTRUCTABLE_AS_OF");
  assert.deepEqual(a.filter((x) => x.usable_for_backtest).map((x) => x.input), ["Waiver 2.0 LIVE_CAPTURED weekly records with attached outcomes"]);
  assert.ok(a.every((x) => x.reason.length > 20));
});
test("the suite REFUSES anything that is not TRUE_AS_OF_HISTORY and never fabricates a metric from nothing", () => {
  const d = (over: Partial<DecisionOutcome>): DecisionOutcome => ({ decision_id: "d", evidence_class: "TRUE_AS_OF_HISTORY", archetype: "IMMEDIATE_STARTER", role_persisted_points_at_decision: 0, chosen_points_started: 30, drop_points_lost: 5, best_alternative_points_started: 40, role_share_change: 0.03, faab_spent: 10, starter_slot_improvement: 4, replacement_level_points: 3, weeks_held: 4, drop_regret_points: 2, ...over });
  const r = scoreDecisions([d({ decision_id: "a" }), d({ decision_id: "b", evidence_class: "RETROSPECTIVE_ONLY" }), d({ decision_id: "c", evidence_class: "UNSAFE_FOR_BACKTEST" }), d({ decision_id: "e", archetype: "ROLE_GROWTH_BREAKOUT", role_share_change: -0.02, faab_spent: 0 })]);
  assert.equal(r.scored, 2); assert.deepEqual(r.refused.map((x) => x.decision_id).sort(), ["b", "c"]); assert.match(r.refused[0]!.reason, /not backtest-grade/);
  assert.equal(r.metrics.net_roster_value, 25); assert.equal(r.metrics.alternative_regret, 10); assert.equal(r.metrics.breakout_identification, 0); assert.equal(r.metrics.faab_efficiency, 2.5);
  const none = scoreDecisions([d({ evidence_class: "RETROSPECTIVE_ONLY" })]); assert.equal(none.scored, 0); assert.ok(Object.values(none.metrics).every((v) => v === null), "no eligible decisions -> no numbers");
});

test("CAPTURE identity covers the whole decision: identical evaluation -> identical id; any input/output/class change -> a different capture", () => {
  const a = cap("LIVE_CAPTURED"); const b = cap("LIVE_CAPTURED"); assert.equal(a.capture_id, b.capture_id); assert.equal(a.content_hash, b.content_hash); assert.match(a.capture_id, /^w2cap:[0-9a-f]{16}$/);
  assert.notEqual(cap("LIVE_POST_LOCK").capture_id, a.capture_id, "the capture class is part of the identity");
  const other = cap("LIVE_CAPTURED", fx({ freeAgents: [{ id: "fa1", pos: "WR", pts: 12, team: "CHI", ros: 150 }] })); assert.notEqual(other.capture_id, a.capture_id);
  assert.ok(a.actions.length > 0 && a.evidence.role === null && a.scoring_fingerprint && a.model_version === "waiver-2.0-shadow-2026.1" && a.pool.candidate_ids.includes("fa1") && a.roster.roster_hash.length === 12);
});
test("CAPTURE classes follow the 3.5A rules and are never merged: certified+pre-lock => LIVE_CAPTURED; post-lock; unverified; reconstructed", () => {
  const ok = evaluateWaiver2(fx()); const unc = evaluateWaiver2(fx({ cert: "UNCERTIFIED_UNROSTERED" }));
  assert.equal(captureKindFor(ok, { games_started_or_finished: false, is_reconstruction: false }), "LIVE_CAPTURED"); assert.equal(captureKindFor(ok, { games_started_or_finished: true, is_reconstruction: false }), "LIVE_POST_LOCK");
  assert.equal(captureKindFor(ok, { games_started_or_finished: null, is_reconstruction: false }), "LIVE_UNVERIFIED"); assert.equal(captureKindFor(unc, { games_started_or_finished: false, is_reconstruction: false }), "LIVE_UNVERIFIED", "an uncertified pool can never be a pristine capture");
  assert.equal(captureKindFor(ok, { games_started_or_finished: false, is_reconstruction: true }), "HISTORICALLY_RECONSTRUCTED");
});
test("CAPTURE STORE: insert-only, idempotent, tamper-evident; outcomes attach separately and never touch the decision", () => {
  const s = new MemoryWaiverCaptureStore(); const r = cap("LIVE_CAPTURED");
  assert.equal(s.record(r).status, "INSERTED"); assert.equal(s.record(r).status, "DUPLICATE_IDENTICAL"); assert.equal(s.list().length, 1);
  assert.equal(s.record({ ...r, captured_at: "2030-01-01T00:00:00.000Z" }).status, "REFUSED", "a re-stamped record with the same id is refused (immutable)");
  const tampered = { ...r, actions: r.actions.map((a) => ({ ...a, net_action_value: 99 })) }; const t = s.record(tampered); assert.equal(t.status, "REFUSED"); assert.match(t.reason!, /content_hash does not match/);
  assert.equal(s.record({ ...r, capture_kind: "NOPE" as never }).status, "REFUSED");
  const before = JSON.stringify(s.list()[0]); const out: WaiverOutcome = { capture_id: r.capture_id, source: "sleeper", recorded_at: "2026-09-30T00:00:00.000Z", claim_result: "WON", winning_bid: 12, realized: { candidate_points_started: 31, drop_points_lost: 2, role_share_change: 0.04, roster_survival_weeks: 5, best_alternative_points_started: 28 } };
  assert.equal(s.attachOutcome(out).status, "INSERTED"); assert.equal(s.attachOutcome(out).status, "DUPLICATE_IDENTICAL"); assert.equal(s.attachOutcome({ ...out, winning_bid: 13 }).status, "REFUSED"); assert.equal(s.attachOutcome({ ...out, capture_id: "w2cap:missing" }).status, "REFUSED");
  assert.equal(JSON.stringify(s.list()[0]), before, "attaching an outcome never mutates the capture");
});
test("EVIDENCE GATE: only LIVE_CAPTURED records with outcomes on enough distinct weeks count; reconstructed / post-lock / unverified never do; nothing is eligible today", () => {
  const s = new MemoryWaiverCaptureStore(); assert.equal(waiver2EvidenceGate(s).status, "NOT_ELIGIBLE"); assert.equal(waiver2EvidenceGate(s).distinct_weeks, 0);
  const recs = [cap("HISTORICALLY_RECONSTRUCTED"), cap("LIVE_POST_LOCK"), cap("LIVE_UNVERIFIED")]; for (const r of recs) { s.record(r); s.attachOutcome({ capture_id: r.capture_id, source: "x", recorded_at: "t", claim_result: "UNKNOWN", winning_bid: null, realized: { candidate_points_started: 1, drop_points_lost: 0, role_share_change: 0, roster_survival_weeks: 1, best_alternative_points_started: 1 } }); }
  const g = waiver2EvidenceGate(s); assert.equal(g.eligible_records, 0); assert.equal(g.status, "NOT_ELIGIBLE"); assert.deepEqual(Object.keys(g.excluded).sort(), ["HISTORICALLY_RECONSTRUCTED", "LIVE_POST_LOCK", "LIVE_UNVERIFIED"]);
  for (let w = 0; w < WAIVER2_EVIDENCE_MIN_WEEKS; w++) { const inp = fx({ week: 2 + w }); const r = buildCaptureRecord(evaluateWaiver2(inp), inp, { ...M, kind: "LIVE_CAPTURED" }); s.record(r); s.attachOutcome({ capture_id: r.capture_id, source: "x", recorded_at: "t", claim_result: "WON", winning_bid: 5, realized: { candidate_points_started: 10, drop_points_lost: 1, role_share_change: 0.02, roster_survival_weeks: 3, best_alternative_points_started: 9 } }); }
  const ok = waiver2EvidenceGate(s); assert.equal(ok.status, "ELIGIBLE_FOR_REVIEW"); assert.equal(ok.distinct_weeks, WAIVER2_EVIDENCE_MIN_WEEKS); assert.match(ok.reasons[0]!, /SEPARATE certification/);
});
test("the capture path is not wired into any request path, and the persistence migration is prepared but NOT applied", () => {
  for (const f of ["lib/book-ready/query.ts", "lib/book-ready/families/waiver2.ts", "lib/weekly/intelligence.ts"]) assert.doesNotMatch(readFileSync(f, "utf8"), /waiver2\/capture|MemoryWaiverCaptureStore|buildCaptureRecord/, f);
  const sql = readFileSync("supabase/migrations/20260920190000_waiver2_shadow_captures.sql", "utf8"); assert.match(sql, /PREPARED, NOT APPLIED/); assert.match(sql, /LIVE_CAPTURED.*LIVE_POST_LOCK.*LIVE_UNVERIFIED.*HISTORICALLY_RECONSTRUCTED/s); assert.match(sql, /before update or delete/);
});
