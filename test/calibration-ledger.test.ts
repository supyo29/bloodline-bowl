/**
 * Projection Calibration Phase 1 — ledger tests: player-level kickoff rule, identity, scoring translation, metrics,
 * idempotency/revisions, missing-evidence states, and the Week 3 ATL–GB adversarial case (fixtures mirror the real
 * production timestamps: Thursday kickoff 2026-09-25T00:15Z, first durable Week 3 snapshot recorded 2026-09-26T23:48Z).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { selectPregameEvidence } from "@/lib/calibration/evidence-selection";
import { aggregateMetrics, caseErrors, rangeResult } from "@/lib/calibration/metrics";
import { buildWeekCases, caseId, type BuildWeekInput, type LeagueScoringInput, type PlayerIdentity } from "@/lib/calibration/case-builder";
import { buildNflGames } from "@/lib/calibration/games";
import { buildCalibrationReport } from "@/lib/calibration/report";
import { buildLedgerWeekAudit } from "@/lib/calibration/audit";
import { selectPregameWeather } from "@/lib/calibration/weather";
import { candidatesFromCapture, candidateFromSnapshotRow, identityFromSnapshotRow, mergeFallbackIdentities, resolveWeekIdentities, unresolvedIdentitiesFromStats } from "@/lib/calibration/materialize";
import { writeCases } from "@/lib/calibration/store";
import type { SupabaseRest } from "@/lib/persistence/supabase/rest";
import type { ProjectionCandidate, NflGame } from "@/lib/calibration/types";

const PPR = { rec: 1, rec_yd: 0.1, rush_yd: 0.1, pass_yd: 0.04, pass_td: 4 };
const STD = { rec: 0, rec_yd: 0.1, rush_yd: 0.1, pass_yd: 0.04, pass_td: 4 };
const YAHOO = { ...PPR, yahoo_stat_57: 0.5 };

const game = (id: string, home: string, away: string, kickoff: string, status = "complete"): NflGame => ({ nfl_game_id: id, season: 2026, week: 3, home_team: home, away_team: away, kickoff_at: kickoff, kickoff_source: "espn_scoreboard", status, provenance: {} });
const GAMES = [
  game("g-thu", "GB", "ATL", "2026-09-25T00:15:00.000Z"),
  game("g-1pm", "BUF", "LAC", "2026-09-27T17:00:00.000Z"),
  game("g-4pm", "SF", "ARI", "2026-09-27T20:05:00.000Z"),
  game("g-snf", "DEN", "LAR", "2026-09-28T00:20:00.000Z"),
];

let n = 0;
const cand = (over: Partial<ProjectionCandidate>): ProjectionCandidate => ({
  kind: "PROJECTION_SNAPSHOT", artifact_id: `a${++n}`, content_hash: "h", request_fingerprint: "legacy:v0", recorded_at: "2026-09-22T00:00:00Z", league_slug: "L1", scoring_fingerprint: "fp1",
  source: "sleeper_weekly", model_version: "sleeper-weekly-rotowire", projected_points: 10, floor_points: 5, ceiling_points: 15, std_dev: 3, expected_availability: 1, injury_status: null,
  warnings: [], nfl_team: "BUF", opponent: "LAC", position: "WR", scoring_exactness: "LEAGUE_EXACT", ...over,
});
const ident = (canonical: string, sid: string | null, team: string, position: string, extra: Partial<PlayerIdentity> = {}): PlayerIdentity => ({ canonical_player_id: canonical, sleeper_id: sid, provider_ids: sid ? { sleeper_id: sid } : {}, name: canonical, position, nfl_team: team, resolved: true, ...extra });

describe("player-level kickoff rule", () => {
  const KO = "2026-09-27T17:00:00.000Z";
  test("chooses the latest projection recorded before kickoff", () => {
    const s = selectPregameEvidence([cand({ artifact_id: "early", recorded_at: "2026-09-26T00:00:00Z" }), cand({ artifact_id: "late", recorded_at: "2026-09-27T14:17:00Z" })], KO);
    assert.equal(s.chosen?.artifact_id, "late");
  });
  test("rejects a projection created at or after kickoff (equality is not 'before')", () => {
    const s = selectPregameEvidence([cand({ artifact_id: "at", recorded_at: KO }), cand({ artifact_id: "after", recorded_at: "2026-09-27T17:00:01Z" })], KO);
    assert.equal(s.chosen, null); assert.equal(s.rejected_not_before_kickoff, 2);
  });
  test("an unparseable recorded_at is never provably pre-kickoff", () => {
    assert.equal(selectPregameEvidence([cand({ recorded_at: "garbage" })], KO).chosen, null);
  });
  test("a candidate with no projected number is invalid evidence and is not chosen", () => {
    const s = selectPregameEvidence([cand({ artifact_id: "num", recorded_at: "2026-09-26T00:00:00Z" }), cand({ artifact_id: "null", recorded_at: "2026-09-27T00:00:00Z", projected_points: null })], KO);
    assert.equal(s.chosen?.artifact_id, "num"); assert.equal(s.rejected_invalid, 1);
  });
  test("deterministic tie: same instant -> PROJECTION_SNAPSHOT beats STARTSIT_CAPTURE; then artifact_id ascending; input order irrelevant", () => {
    const a = cand({ artifact_id: "zzz", recorded_at: "2026-09-27T10:00:00Z" });
    const b = cand({ artifact_id: "aaa", kind: "STARTSIT_CAPTURE", recorded_at: "2026-09-27T10:00:00Z" });
    const c = cand({ artifact_id: "mmm", recorded_at: "2026-09-27T10:00:00Z" });
    assert.equal(selectPregameEvidence([a, b, c], KO).chosen?.artifact_id, "mmm");
    assert.equal(selectPregameEvidence([c, b, a], KO).chosen?.artifact_id, "mmm");
  });
});

/* ------------------------------ Week 3 adversarial fixture ------------------------------ */
const TIMES = { capThu: "2026-09-22T20:29:34Z", snapThuLate: "2026-09-26T23:48:03Z", snapA: "2026-09-27T12:01:42Z", snapB: "2026-09-27T14:17:00Z", capLate: "2026-09-27T14:18:02Z", snapC: "2026-09-27T19:59:43Z" };
type Mut = BuildWeekInput & { identities: Map<string, PlayerIdentity>; candidates: Map<string, ProjectionCandidate[]> };
function week3(): Mut {
  const identities = new Map<string, PlayerIdentity>([
    ["player:gsis:love", ident("player:gsis:love", "111", "GB", "QB")],
    ["player:sleeper:gb", ident("player:sleeper:gb", "GB", "GB", "DEF")],
    ["player:gsis:onepm", ident("player:gsis:onepm", "222", "BUF", "WR")],
    ["player:gsis:fourpm", ident("player:gsis:fourpm", "333", "SF", "WR")],
    ["player:gsis:snf", ident("player:gsis:snf", "444", "DEN", "WR")],
  ]);
  const candidates = new Map<string, ProjectionCandidate[]>();
  const add = (canonical: string, c: ProjectionCandidate) => { const k = `L1|${canonical}`; candidates.set(k, [...(candidates.get(k) ?? []), c]); };
  const snaps: Array<[string, string]> = [["snapThuLate", TIMES.snapThuLate], ["snapA", TIMES.snapA], ["snapB", TIMES.snapB], ["snapC", TIMES.snapC]];
  for (const [canonical, team, pos] of [["player:gsis:love", "GB", "QB"], ["player:sleeper:gb", "GB", "DEF"], ["player:gsis:onepm", "BUF", "WR"], ["player:gsis:fourpm", "SF", "WR"], ["player:gsis:snf", "DEN", "WR"]] as const) {
    for (const [id, t] of snaps) add(canonical, cand({ artifact_id: id, recorded_at: t, nfl_team: team, position: pos }));
  }
  // Start/Sit captures: pre-Thursday one (valid for GB players) + a late Sunday one that also contains Love (invalid for him, valid for nobody else here)
  add("player:gsis:love", cand({ kind: "STARTSIT_CAPTURE", artifact_id: "capThu", recorded_at: TIMES.capThu, nfl_team: "GB", position: "QB", projected_points: 18.5 }));
  add("player:sleeper:gb", cand({ kind: "STARTSIT_CAPTURE", artifact_id: "capThu", recorded_at: TIMES.capThu, nfl_team: "GB", position: "DEF", projected_points: 6.1, scoring_exactness: "PROVIDER_STANDARD_APPROXIMATION" }));
  add("player:gsis:love", cand({ kind: "STARTSIT_CAPTURE", artifact_id: "capLate", recorded_at: TIMES.capLate, nfl_team: "GB", position: "QB", projected_points: 30 }));
  const stats = new Map<string, Record<string, number>>([
    ["111", { pass_yd: 250, pass_td: 2, gp: 1, off_snp: 60, tm_off_snp: 60 }],
    ["GB", { pts_std: 9, gp: 1 }],
    ["222", { rec: 5, rec_yd: 50, gp: 1, off_snp: 50, tm_off_snp: 60 }],
    ["333", { rec: 4, rec_yd: 40, gp: 1, off_snp: 50, tm_off_snp: 60 }],
    ["444", { rec: 3, rec_yd: 30, gp: 1, off_snp: 50, tm_off_snp: 60 }],
  ]);
  const leagues: LeagueScoringInput[] = [{ league_slug: "L1", provider: "sleeper", scoring_fingerprint: "fp1", raw_scoring: PPR }];
  return { season: 2026, week: 3, now: "2026-09-29T00:00:00Z", stats_source: "test", games: GAMES, leagues, identities, candidates, actuals: { clean: stats, raw: stats }, weather: [], existing: new Map() };
}
const byPlayer = (r: ReturnType<typeof buildWeekCases>, p: string) => r.cases.find((c) => c.canonical_player_id === p)!;

describe("Week 3 adversarial: ATL–GB Thursday vs Sunday/Monday", () => {
  test("Jordan Love uses the pre-Thursday Start/Sit capture — never the 09-26 snapshot, never the later capture", () => {
    const c = byPlayer(buildWeekCases(week3()), "player:gsis:love");
    assert.equal(c.projection_artifact_id, "capThu"); assert.equal(c.projection_artifact_kind, "STARTSIT_CAPTURE"); assert.equal(c.projected_points, 18.5);
    assert.equal(c.projection_selection.rejected_not_before_kickoff, 5); // 4 snapshots + the late capture
    assert.equal(c.kickoff_at, "2026-09-25T00:15:00.000Z");
    assert.equal(c.evidence_status, "CERTIFIED");
  });
  test("Green Bay DST uses the pre-Thursday capture and is flagged approximate (K/DST provider-standard points)", () => {
    const c = byPlayer(buildWeekCases(week3()), "player:sleeper:gb");
    assert.equal(c.projection_artifact_id, "capThu"); assert.equal(c.evidence_status, "CERTIFIED_APPROXIMATE_SCORING");
    assert.equal(c.projection_scoring_exactness, "PROVIDER_STANDARD_APPROXIMATION"); assert.equal(c.actual_scoring_exactness, "PROVIDER_STANDARD_APPROXIMATION");
    assert.equal(c.actual_fantasy_points, 9); assert.equal(c.error, 2.9);
  });
  test("if the ONLY evidence is the post-Thursday snapshot, Thursday players get NO certified projection (no hindsight)", () => {
    const inp = week3();
    for (const k of ["L1|player:gsis:love", "L1|player:sleeper:gb"]) inp.candidates.set(k, inp.candidates.get(k)!.filter((c) => c.kind === "PROJECTION_SNAPSHOT"));
    const r = buildWeekCases(inp);
    for (const p of ["player:gsis:love", "player:sleeper:gb"]) { const c = byPlayer(r, p); assert.equal(c.evidence_status, "NO_PREKICKOFF_PROJECTION"); assert.equal(c.projected_points, null); assert.equal(c.error, null); assert.equal(c.projection_artifact_id, null); }
  });
  test("Sunday 1pm / 4pm / Sunday-night players each get their own latest valid pre-kickoff snapshot", () => {
    const r = buildWeekCases(week3());
    assert.equal(byPlayer(r, "player:gsis:onepm").projection_artifact_id, "snapB");  // 14:17Z < 17:00Z, snapC (19:59Z) rejected
    assert.equal(byPlayer(r, "player:gsis:fourpm").projection_artifact_id, "snapC"); // 19:59:43Z < 20:05Z
    assert.equal(byPlayer(r, "player:gsis:snf").projection_artifact_id, "snapC");    // 09-28T00:20Z
    assert.equal(byPlayer(r, "player:gsis:onepm").projection_selection.rejected_not_before_kickoff, 1);
  });
  test("Thursday having played does not invalidate Sunday evidence", () => {
    const inp = week3();
    const r = buildWeekCases(inp);
    for (const p of ["player:gsis:onepm", "player:gsis:fourpm", "player:gsis:snf"]) assert.equal(byPlayer(r, p).evidence_status, "CERTIFIED");
  });
});

describe("identity", () => {
  test("canonical id is stable across projection/outcome join; provider ids stay provenance, not identity", () => {
    const r = buildWeekCases(week3());
    const love = byPlayer(r, "player:gsis:love");
    assert.equal(love.canonical_player_id, "player:gsis:love"); assert.deepEqual(love.provider_player_ids, { sleeper_id: "111" });
    assert.equal(r.football_outcomes.find((o) => o.canonical_player_id === "player:gsis:love")?.provider_player_ids.sleeper_id, "111");
  });
  test("team defense joins by its canonical team-defense id and stat row keyed by team code", () => {
    assert.equal(byPlayer(buildWeekCases(week3()), "player:sleeper:gb").actual_fantasy_points, 9);
  });
  test("snapshot row -> identity keeps the crosswalk sleeper id and marks resolved", () => {
    const i = identityFromSnapshotRow({ canonical_player_id: "player:gsis:x", projection: { position: "WR" }, resolved_player: { full_name: "X", nfl_team: "BUF", position: "WR", identifiers: { sleeper_id: 9, gsis_id: "x" } } });
    assert.equal(i.sleeper_id, "9"); assert.equal(i.resolved, true); assert.equal(i.canonical_player_id, "player:gsis:x");
  });
  test("an unresolved provider identity is an explicit UNRESOLVED_IDENTITY case", () => {
    const inp = week3();
    inp.identities.set("unresolved:sleeper:999", ident("unresolved:sleeper:999", "999", "BUF", "WR", { resolved: false }));
    (inp.actuals!.raw as Map<string, Record<string, number>>).set("999", { rec: 1, rec_yd: 10, gp: 1 });
    const c = byPlayer(buildWeekCases(inp), "unresolved:sleeper:999");
    assert.equal(c.evidence_status, "UNRESOLVED_IDENTITY"); assert.equal(c.error, null);
  });
});

describe("scoring translation", () => {
  test("one football outcome, two league translations: actuals follow each league's scoring fingerprint", () => {
    const inp = week3();
    inp.leagues = [{ league_slug: "L1", provider: "sleeper", scoring_fingerprint: "fp1", raw_scoring: PPR }, { league_slug: "L2", provider: "sleeper", scoring_fingerprint: "fp2", raw_scoring: STD }];
    for (const c of inp.candidates.get("L1|player:gsis:onepm")!) inp.candidates.set("L2|player:gsis:onepm", [...(inp.candidates.get("L2|player:gsis:onepm") ?? []), { ...c, league_slug: "L2", scoring_fingerprint: "fp2" }]);
    const r = buildWeekCases(inp);
    const a = r.cases.find((c) => c.league_slug === "L1" && c.canonical_player_id === "player:gsis:onepm")!;
    const b = r.cases.find((c) => c.league_slug === "L2" && c.canonical_player_id === "player:gsis:onepm")!;
    assert.equal(a.actual_fantasy_points, 10); assert.equal(b.actual_fantasy_points, 5); // 5 rec*1 + 5.0 yd pts vs 0 + 5.0
    assert.notEqual(a.scoring_fingerprint, b.scoring_fingerprint); assert.notEqual(a.case_id, b.case_id);
    assert.equal(a.football_outcome_id, b.football_outcome_id); assert.equal(a.stats_digest, b.stats_digest); // ONE football reality
    assert.equal(r.football_outcomes.filter((o) => o.canonical_player_id === "player:gsis:onepm").length, 1);
  });
  test("a projection scored under a different fingerprint than the league's is never graded against a mismatched actual", () => {
    const inp = week3(); inp.leagues = [{ league_slug: "L1", provider: "sleeper", scoring_fingerprint: "fpNEW", raw_scoring: PPR }];
    const c = byPlayer(buildWeekCases(inp), "player:gsis:onepm");
    assert.equal(c.evidence_status, "SCORING_FINGERPRINT_MISMATCH"); assert.equal(c.actual_fantasy_points, null); assert.equal(c.error, null);
  });
  test("Yahoo-style unmapped scoring stats are explicit, not league-exact", () => {
    const inp = week3(); inp.leagues = [{ league_slug: "L1", provider: "yahoo", scoring_fingerprint: "fp1", raw_scoring: YAHOO }];
    const c = byPlayer(buildWeekCases(inp), "player:gsis:onepm");
    assert.equal(c.evidence_status, "CERTIFIED_APPROXIMATE_SCORING"); assert.equal(c.actual_scoring_exactness, "LEAGUE_EXACT_WITH_UNMAPPED_STATS"); assert.equal(c.provider, "yahoo");
  });
  test("unavailable league scoring (e.g. Yahoo canonical state failed) -> ACTUAL_SCORING_UNAVAILABLE, projection evidence preserved", () => {
    const inp = week3(); inp.leagues = [{ league_slug: "L1", provider: "yahoo", scoring_fingerprint: null, raw_scoring: null, note: "yahoo unavailable" }];
    const c = byPlayer(buildWeekCases(inp), "player:gsis:onepm");
    assert.equal(c.evidence_status, "ACTUAL_SCORING_UNAVAILABLE"); assert.equal(c.actual_fantasy_points, null); assert.equal(c.projection_artifact_id, "snapB"); assert.ok(c.evidence_notes.includes("yahoo unavailable"));
  });
});

describe("metrics (hand-verifiable)", () => {
  test("error / abs / squared = actual - projected", () => {
    assert.deepEqual(caseErrors(14, 1.7), { error: -12.3, abs_error: 12.3, squared_error: 151.29 });
    assert.deepEqual(caseErrors(5, 8), { error: 3, abs_error: 3, squared_error: 9 });
  });
  test("floor/ceiling: inclusive band; missing/inverted range is RANGE_UNAVAILABLE", () => {
    assert.equal(rangeResult(4.99, 5, 15).range_status, "BELOW_FLOOR"); assert.equal(rangeResult(5, 5, 15).range_status, "INSIDE_RANGE");
    assert.equal(rangeResult(15, 5, 15).range_status, "INSIDE_RANGE"); assert.equal(rangeResult(15.01, 5, 15).range_status, "ABOVE_CEILING");
    assert.equal(rangeResult(9, null, 15).range_status, "RANGE_UNAVAILABLE"); assert.equal(rangeResult(9, 15, 5).range_status, "RANGE_UNAVAILABLE"); assert.equal(rangeResult(null, 5, 15).range_status, "NOT_EVALUATED");
  });
  test("aggregate: errors [+3, -1, -2, +4] -> bias 1, MAE 2.5, RMSE sqrt(7.5), coverage 2/4", () => {
    const mk = (p: number, a: number, floor: number, ceil: number) => { const e = caseErrors(p, a); return { ...e, ...rangeResult(a, floor, ceil) }; };
    const m = aggregateMetrics([mk(5, 8, 2, 7), mk(5, 4, 2, 7), mk(5, 3, 2, 7), mk(5, 9, 2, 7)]);
    assert.equal(m.n, 4); assert.equal(m.bias, 1); assert.equal(m.mae, 2.5); assert.equal(m.rmse, 2.7386); // sqrt((9+1+4+16)/4)=sqrt(7.5)
    assert.equal(m.range_n, 4); assert.equal(m.inside_range, 2); assert.equal(m.above_ceiling, 2); assert.equal(m.below_floor, 0); assert.equal(m.coverage_rate, 0.5);
  });
  test("aggregation excludes ungraded rows and reports null (never 0) for an empty population", () => {
    const m = aggregateMetrics([{ error: null, abs_error: null, squared_error: null, range_status: "NOT_EVALUATED" }]);
    assert.equal(m.n, 0); assert.equal(m.bias, null); assert.equal(m.rmse, null); assert.equal(m.coverage_rate, null);
  });
  test("report groups by league/position/approximation and only grades certified cases", () => {
    const r = buildWeekCases(week3());
    const rep = buildCalibrationReport(r.cases, ["scoring_approximation"]);
    const exact = rep.groups.find((g) => g.key.scoring_approximation === "EXACT")!; const approx = rep.groups.find((g) => g.key.scoring_approximation === "APPROXIMATE")!;
    assert.equal(approx.total_cases, 1); assert.equal(exact.total_cases, 4);
    assert.equal(rep.graded_cases, 5);
    const audit = buildLedgerWeekAudit(r.cases); assert.equal(audit.total_cases, 5); assert.equal(audit.graded_cases, 5); assert.match(audit.ledger_digest, /^[0-9a-f]{16}$/);
  });
});

describe("idempotency + revisions", () => {
  test("a second materialization over unchanged evidence creates no cases", () => {
    const first = buildWeekCases(week3());
    const heads = new Map(first.cases.map((c) => [c.case_id, { evidence_digest: c.evidence_digest, revision: c.revision, provider_player_ids: c.provider_player_ids }]));
    const second = buildWeekCases({ ...week3(), existing: heads });
    assert.equal(second.cases.length, 0); assert.equal(second.unchanged, first.cases.length);
  });
  test("case ids and digests are deterministic and clock-independent (generated_at excluded)", () => {
    const a = buildWeekCases(week3()), b = buildWeekCases({ ...week3(), now: "2030-01-01T00:00:00Z" });
    assert.deepEqual(a.cases.map((c) => [c.case_id, c.evidence_digest]), b.cases.map((c) => [c.case_id, c.evidence_digest]));
    assert.match(a.cases[0]!.case_id, /^cc:[0-9a-f]{24}$/);
    assert.equal(a.cases[0]!.case_id, caseId(2026, 3, a.cases[0]!.nfl_game_id, a.cases[0]!.canonical_player_id, "L1", "fp1"));
  });
  test("a provider correction writes an explicit NEW revision that supersedes the old one — never a duplicate, never an update", () => {
    const first = buildWeekCases(week3());
    const heads = new Map(first.cases.map((c) => [c.case_id, { evidence_digest: c.evidence_digest, revision: c.revision, provider_player_ids: c.provider_player_ids }]));
    const inp = week3(); (inp.actuals!.raw as Map<string, Record<string, number>>).set("222", { rec: 6, rec_yd: 50, gp: 1, off_snp: 50, tm_off_snp: 60 }); (inp.actuals!.clean as Map<string, Record<string, number>>).set("222", { rec: 6, rec_yd: 50, gp: 1, off_snp: 50, tm_off_snp: 60 });
    const second = buildWeekCases({ ...inp, existing: heads });
    assert.equal(second.cases.length, 1); assert.equal(second.revisions_of_existing, 1);
    const rev = second.cases[0]!; const old = first.cases.find((c) => c.case_id === rev.case_id)!;
    assert.equal(rev.revision, 2); assert.equal(rev.supersedes_evidence_digest, old.evidence_digest); assert.notEqual(rev.evidence_digest, old.evidence_digest);
    assert.equal(rev.projection_artifact_id, old.projection_artifact_id); // projection evidence is never rewritten
  });
  test("store: a repeated write inserts nothing (conflict target is the real unique key)", async () => {
    const seen = new Set<string>(); const targets: string[][] = [];
    const rest = { insertIgnoreDuplicates: async (_t: string, rows: Array<{ case_id: string; evidence_digest: string }>, cols: string[]) => { targets.push(cols); const ins = rows.filter((r) => { const k = `${r.case_id}|${r.evidence_digest}`; if (seen.has(k)) return false; seen.add(k); return true; }); return ins; } } as unknown as SupabaseRest;
    const cases = buildWeekCases(week3()).cases;
    const a = await writeCases(rest, cases), b = await writeCases(rest, cases);
    assert.equal(a.inserted, cases.length); assert.equal(b.inserted, 0); assert.equal(b.duplicate, cases.length); assert.deepEqual(targets[0], ["case_id", "evidence_digest"]);
  });
});

describe("missing / degraded evidence states", () => {
  test("DNP in a covered game: real zero, participation DID_NOT_PLAY, still graded but explicitly classified", () => {
    const inp = week3();
    for (let i = 0; i < 9; i++) { inp.identities.set(`player:gsis:f${i}`, ident(`player:gsis:f${i}`, `9${i}`, "BUF", "RB")); (inp.actuals!.raw as Map<string, Record<string, number>>).set(`9${i}`, { rush_yd: 1, gp: 1 }); }
    inp.identities.set("player:gsis:dnp", ident("player:gsis:dnp", "555", "BUF", "WR"));
    inp.candidates.set("L1|player:gsis:dnp", [cand({ recorded_at: "2026-09-27T14:00:00Z", projected_points: 14, nfl_team: "BUF" })]);
    const c = byPlayer(buildWeekCases(inp), "player:gsis:dnp");
    assert.equal(c.participation_state, "DID_NOT_PLAY"); assert.equal(c.actual_fantasy_points, 0); assert.equal(c.error, -14);
  });
  test("known-Out at projection time -> INACTIVE (distinct from an ordinary DNP or a low-scoring healthy game)", () => {
    const inp = week3();
    for (let i = 0; i < 9; i++) { inp.identities.set(`player:gsis:f${i}`, ident(`player:gsis:f${i}`, `9${i}`, "BUF", "RB")); (inp.actuals!.raw as Map<string, Record<string, number>>).set(`9${i}`, { rush_yd: 1, gp: 1 }); }
    inp.identities.set("player:gsis:out", ident("player:gsis:out", "556", "BUF", "WR"));
    inp.candidates.set("L1|player:gsis:out", [cand({ recorded_at: "2026-09-27T14:00:00Z", projected_points: 1, injury_status: "Out", nfl_team: "BUF" })]);
    assert.equal(byPlayer(buildWeekCases(inp), "player:gsis:out").participation_state, "INACTIVE");
  });
  test("healthy 65-snap 1.7-point game is PLAYED_NORMAL, not the same state as an early exit/DNP", () => {
    const inp = week3(); const s = { rec: 1, rec_yd: 7, gp: 1, off_snp: 65, tm_off_snp: 70 };
    (inp.actuals!.raw as Map<string, Record<string, number>>).set("222", s); (inp.actuals!.clean as Map<string, Record<string, number>>).set("222", s);
    const c = byPlayer(buildWeekCases(inp), "player:gsis:onepm");
    assert.equal(c.participation_state, "PLAYED_NORMAL"); assert.equal(c.actual_fantasy_points, 1.7);
  });
  test("low snap share is preserved as an explicit descriptive state", () => {
    const inp = week3(); const s = { rec: 1, rec_yd: 7, gp: 1, off_snp: 10, tm_off_snp: 70 };
    (inp.actuals!.raw as Map<string, Record<string, number>>).set("222", s); (inp.actuals!.clean as Map<string, Record<string, number>>).set("222", s);
    assert.equal(byPlayer(buildWeekCases(inp), "player:gsis:onepm").participation_state, "PLAYED_LOW_SNAP_SHARE");
  });
  test("no coverage for the team's game and no row -> actual UNAVAILABLE, never a silent zero", () => {
    const inp = week3(); (inp.actuals!.raw as Map<string, Record<string, number>>).delete("222"); (inp.actuals!.clean as Map<string, Record<string, number>>).delete("222");
    const c = byPlayer(buildWeekCases(inp), "player:gsis:onepm");
    assert.equal(c.evidence_status, "ACTUAL_SCORING_UNAVAILABLE"); assert.equal(c.actual_fantasy_points, null); assert.equal(c.error, null);
  });
  test("stats source unavailable -> ACTUAL_SCORING_UNAVAILABLE for everyone; projection evidence still recorded", () => {
    const inp = week3(); inp.actuals = null;
    const r = buildWeekCases(inp);
    assert.ok(r.cases.every((c) => c.evidence_status === "ACTUAL_SCORING_UNAVAILABLE" && c.projected_points != null)); assert.equal(r.football_outcomes.length, 0);
  });
  test("games not yet final are not materialized; postponed/cancelled are recorded explicitly", () => {
    const inp = week3(); inp.games = [game("g-1pm", "BUF", "LAC", "2026-09-27T17:00:00.000Z", "in_game"), game("g-thu", "GB", "ATL", "2026-09-25T00:15:00.000Z", "postponed"), ...GAMES.slice(2)];
    const r = buildWeekCases(inp);
    assert.equal(r.skipped_game_not_final, 1); assert.ok(!r.cases.some((c) => c.canonical_player_id === "player:gsis:onepm"));
    const love = byPlayer(r, "player:gsis:love"); assert.equal(love.participation_state, "GAME_POSTPONED_OR_CANCELLED"); assert.equal(love.evidence_status, "GAME_NOT_PLAYED"); assert.equal(love.error, null);
  });
  test("a bye-week player has no game and no case", () => {
    const inp = week3(); inp.identities.set("player:gsis:bye", ident("player:gsis:bye", "777", "NYG", "WR")); inp.candidates.set("L1|player:gsis:bye", [cand({ nfl_team: "NYG" })]);
    const r = buildWeekCases(inp); assert.ok(r.skipped_no_game >= 1); assert.ok(!r.cases.some((c) => c.canonical_player_id === "player:gsis:bye"));
  });
});

describe("adapters + weather + game identity", () => {
  test("snapshot candidate carries floor/ceiling/std/availability/injury/warnings and flags K/DST approximation", () => {
    const meta = { artifact_id: "projsnap:x", content_hash: "c", league_slug: "L1", scoring_fingerprint: "fp1", request_fingerprint: "legacy:v0", source: "sleeper_weekly", model_version: "sleeper-weekly-rotowire", recorded_at: "2026-09-27T12:00:00Z", warnings: [] };
    const c = candidateFromSnapshotRow(meta, { canonical_player_id: "player:sleeper:atl", projection: { position: "DEF", nfl_team: "ATL", opponent: "GB", projected_points: 5.61, floor_points: 2.87, ceiling_points: 8.35, std_dev: 3.25, expected_availability: 1, injury_status: null, warnings: ["k_dst_uses_sleeper_standard_points (x)"], source: "sleeper_weekly", model_version: "sleeper-weekly-rotowire" }, resolved_player: null }, PPR);
    assert.equal(c.scoring_exactness, "PROVIDER_STANDARD_APPROXIMATION"); assert.equal(c.floor_points, 2.87); assert.equal(c.std_dev, 3.25); assert.deepEqual(c.warnings.length, 1);
  });
  test("capture adapter: baseline only, no fabricated floor/ceiling, capture id + captured_at become the evidence identity", () => {
    const out = candidatesFromCapture({ capture_id: "ssc:1", content_hash: "h", captured_at: "2026-09-22T20:29:34Z", league_slug: "L1", scoring_fingerprint: "fp1", baseline_projection_version: "sleeper-weekly-rotowire", capture_kind: "LIVE_CAPTURED", lock_verdict: "PRE_KICKOFF_VERIFIED", record: { adjustments: [{ canonical_player_id: "player:gsis:love", position: "QB", nfl_team: "GB", opponent: "ATL", baseline_projection: 18.5 }, { canonical_player_id: "player:gsis:none", baseline_projection: null }] } }, PPR);
    assert.equal(out.length, 1); assert.equal(out[0]!.c.floor_points, null); assert.equal(out[0]!.c.artifact_id, "ssc:1"); assert.equal(out[0]!.c.kind, "STARTSIT_CAPTURE");
  });
  test("weather: only a snapshot retrieved before kickoff counts; none -> null (nothing manufactured)", () => {
    const g = { season: 2026, week: 3, home_team: "GB", away_team: "ATL", kickoff_at: "2026-09-25T00:15:00.000Z" };
    const row = (id: string, retrieved_at: string) => ({ id, season: 2026, week: 3, game_id: null, home_team: "GB", away_team: "ATL", source_name: "s", source_timestamp: null, retrieved_at, roof: "outdoors", temp: "61", wind: 8, weather_status: "ok", weather_risk_score: "0.2" });
    assert.equal(selectPregameWeather([], g), null);
    assert.equal(selectPregameWeather([row("late", "2026-09-25T02:00:00Z")], g), null);
    const w = selectPregameWeather([row("a", "2026-09-24T10:00:00Z"), row("b", "2026-09-24T20:00:00Z"), row("late", "2026-09-25T02:00:00Z")], g);
    assert.equal(w?.snapshot_id, "b"); assert.equal(w?.temp, 61); assert.equal(w?.weather_risk_score, 0.2);
  });
  test("NFL games: schedule identity + ESPN kickoff instant joined via canonical team codes (WSH->WAS); missing kickoff fails closed", () => {
    const schedule = [{ week: 3, home: "WAS", away: "SEA", game_id: "s1", status: "complete", date: "2026-09-27" }, { week: 3, home: "GB", away: "ATL", game_id: "s2", status: "complete", date: "2026-09-24" }, { week: 2, home: "X", away: "Y", game_id: "s0" }];
    const { games, missing_kickoff } = buildNflGames(2026, 3, schedule, [{ id: "e1", date: "2026-09-27T17:00Z", home: "WSH", away: "SEA" }]);
    assert.equal(games.length, 1); assert.equal(games[0]!.home_team, "WAS"); assert.equal(games[0]!.kickoff_at, "2026-09-27T17:00:00.000Z"); assert.deepEqual(missing_kickoff, ["s2"]);
  });
});

describe("no production influence (Phase 1 observes and records)", () => {
  const walk = (dir: string, out: string[] = []): string[] => { for (const n of readdirSync(dir)) { const f = join(dir, n); if (statSync(f).isDirectory()) { if (!["node_modules", ".next", "data"].includes(n)) walk(f, out); } else if (/\.(ts|tsx)$/.test(n)) out.push(f); } return out; };
  test("only the weekly audit composer, the calibration routes and lib/calibration itself import lib/calibration", () => {
    const allowed = (f: string) => f.includes(join("lib", "calibration")) || f.includes(join("app", "api", "calibration")) || f.includes(join("app", "api", "cron", "calibration-materialize")) || f.includes(join("lib", "role-calibration")) || f.includes(join("lib", "game-distribution")) || f.includes(join("lib", "game-weather")) || f.includes(join("app", "api", "game-distribution")) || f.includes(join("app", "api", "cron", "game-environment")) || f.includes(join("app", "api", "role-calibration")) || f.includes(join("app", "api", "cron", "role-calibration")) || f.endsWith(join("lib", "weekly-audit", "build.ts")) || f.endsWith(join("lib", "weekly-audit", "contract.ts"));
    const offenders = ["lib", "app"].flatMap((d) => walk(join(process.cwd(), d))).filter((f) => !allowed(f) && /@\/lib\/calibration\//.test(readFileSync(f, "utf8")));
    assert.deepEqual(offenders, []);
  });
  test("lib/calibration never writes to any projection/snapshot/capture table (ledger tables only) and never imports a model or weight module", () => {
    for (const f of walk(join(process.cwd(), "lib", "calibration"))) {
      const src = readFileSync(f, "utf8");
      assert.ok(!/insertIgnoreDuplicates\([^)]*["']bridge_(projection|startsit|matchup2|waiver2)/.test(src) && !/rest\.(update|updateReturning|insert)\(|updateReturning\(/.test(src), f);
      assert.ok(!/from ["']@\/lib\/(projections|weekly\/start-sit-fi|matchup2|waiver2|orchestrator)/.test(src), f);
    }
  });
  test("migration is additive and immutable: no drop/alter of existing tables, insert-only triggers on all three ledger tables", () => {
    const sql = readFileSync("supabase/migrations/20260929150000_projection_calibration_ledger.sql", "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.ok(!/drop table|alter table public\.bridge_(projection|startsit|matchup2|waiver2|weekly)/i.test(sql));
    assert.equal((sql.match(/before update or delete on public\.bridge_calibration_/g) ?? []).length, 3);
  });
});

describe("regression: a week with no snapshot rows must not mass-produce UNRESOLVED_IDENTITY (Week 2 failure mode)", () => {
  const stats = new Map<string, Record<string, number>>([["6804", { pass_yd: 250, pass_att: 30, gp: 1 }], ["13287", { rush_att: 20, rush_yd: 90, gp: 1 }], ["99999", { rec: 2, rec_tgt: 3, gp: 1 }]]);
  const index = new Map([["6804", { position: "QB", team: "GB", full_name: "Jordan Love" }], ["13287", { position: "RB", team: "ARI", full_name: "Jeremiyah Love" }], ["99999", { position: "WR", team: "BUF", full_name: "Mystery" }]]);
  test("reproduces the bug: with an EMPTY identity map every stat-row player becomes unresolved", () => {
    const u = unresolvedIdentitiesFromStats(stats, new Map(), index);
    assert.equal(u.length, 3); assert.ok(u.every((i) => i.canonical_player_id.startsWith("unresolved:") && !i.resolved));
  });
  test("with crosswalk identities borrowed from another week, resolvable players keep their CANONICAL id; only genuinely unknown ids stay unresolved", () => {
    const primary = new Map<string, PlayerIdentity>();
    const fb = new Map<string, PlayerIdentity>([["player:sleeper:6804", ident("player:sleeper:6804", "6804", "GB", "QB")], ["player:gsis:00-0040", ident("player:gsis:00-0040", "13287", "ARI", "RB")]]);
    assert.equal(mergeFallbackIdentities(primary, fb, "crosswalk_fallback:x(week 3)"), 2);
    const u = unresolvedIdentitiesFromStats(stats, primary, index);
    assert.deepEqual(u.map((i) => i.canonical_player_id), ["unresolved:sleeper:99999"]);
    assert.equal(primary.get("player:sleeper:6804")!.identity_source, "crosswalk_fallback:x(week 3)");
  });
  test("fallback never overrides this week's own identity", () => {
    const primary = new Map<string, PlayerIdentity>([["player:gsis:a", ident("player:gsis:a", "1", "BUF", "WR")]]);
    assert.equal(mergeFallbackIdentities(primary, new Map([["player:gsis:a", ident("player:gsis:a", "1", "NYG", "WR")]]), "fb"), 0);
    assert.equal(primary.get("player:gsis:a")!.nfl_team, "BUF"); assert.equal(primary.get("player:gsis:a")!.identity_source, undefined);
  });
  test("a fallback-resolved player with stats but no projection is NO_PREKICKOFF_PROJECTION with a canonical id — never UNRESOLVED_IDENTITY", () => {
    const inp = week3(); inp.candidates.clear(); inp.identities.clear();
    inp.identities.set("player:sleeper:6804", { ...ident("player:sleeper:6804", "111", "GB", "QB"), identity_source: "crosswalk_fallback:x(week 3)" });
    const r = buildWeekCases(inp);
    const c = r.cases[0]!;
    assert.equal(c.canonical_player_id, "player:sleeper:6804"); assert.equal(c.evidence_status, "NO_PREKICKOFF_PROJECTION"); assert.ok(c.evidence_notes.some((n) => n.includes("crosswalk_fallback")));
    assert.ok(!r.cases.some((x) => x.evidence_status === "UNRESOLVED_IDENTITY"));
  });
  test("EXACT production failure: no snapshots BUT Start/Sit captures present -> capture identities must NOT suppress the crosswalk fallback", () => {
    const capture = new Map<string, PlayerIdentity>([["player:sleeper:6804", ident("player:sleeper:6804", "6804", "GB", "QB")]]);
    const fallback = new Map<string, PlayerIdentity>([["player:sleeper:6804", ident("player:sleeper:6804", "6804", "GB", "QB")], ["player:gsis:00-0040", ident("player:gsis:00-0040", "13287", "ARI", "RB")]]);
    const r = resolveWeekIdentities({ snapshot: new Map(), captureOnly: capture, fallback, fallbackSource: "fb" });
    assert.equal(r.fallback_used, true); assert.ok(r.identities.has("player:gsis:00-0040"));
    assert.equal(r.identities.get("player:sleeper:6804")!.identity_source, "fb"); // fallback (full crosswalk) wins over the sparse capture identity
    assert.deepEqual(unresolvedIdentitiesFromStats(stats, r.identities, index).map((i) => i.canonical_player_id), ["unresolved:sleeper:99999"]);
  });
  test("with this week's own snapshot identities the fallback is never used", () => {
    const snap = new Map<string, PlayerIdentity>([["player:gsis:a", ident("player:gsis:a", "1", "BUF", "WR")]]);
    const r = resolveWeekIdentities({ snapshot: snap, captureOnly: new Map(), fallback: new Map([["player:gsis:b", ident("player:gsis:b", "2", "BUF", "WR")]]), fallbackSource: "fb" });
    assert.equal(r.fallback_used, false); assert.equal(r.identities.size, 1);
  });
  test("provenance enrichment: a head written with EMPTY provider ids is superseded exactly once; the re-run and complete heads stay no-ops", () => {
    const first = buildWeekCases(week3());
    const sparseHeads = new Map(first.cases.map((c) => [c.case_id, { evidence_digest: c.evidence_digest, revision: c.revision, provider_player_ids: {} }]));
    const second = buildWeekCases({ ...week3(), existing: sparseHeads });
    assert.equal(second.cases.length, first.cases.length); assert.ok(second.cases.every((c) => c.revision === 2 && c.supersedes_evidence_digest != null));
    assert.ok(second.cases.every((c) => c.projection_artifact_id === first.cases.find((f) => f.case_id === c.case_id)!.projection_artifact_id)); // evidence untouched
    const heads2 = new Map(second.cases.map((c) => [c.case_id, { evidence_digest: c.evidence_digest, revision: c.revision, provider_player_ids: c.provider_player_ids }]));
    assert.equal(buildWeekCases({ ...week3(), existing: heads2 }).cases.length, 0); // idempotent after enrichment
    const completeHeads = new Map(first.cases.map((c) => [c.case_id, { evidence_digest: c.evidence_digest, revision: c.revision, provider_player_ids: c.provider_player_ids }]));
    assert.equal(buildWeekCases({ ...week3(), existing: completeHeads }).cases.length, 0); // already-complete heads: no spurious revisions
  });
});
