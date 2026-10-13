/**
 * W2.P2 — the G3 evaluation run: look policy (no re-looking at the same model after seeing its result), reproducible input bundle, and the
 * read-only calibration-ledger outcomes loader.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateG3, type G3Bundle } from "../lib/role-shadow/g3";
import { runG3, readRunLog, type CliIO } from "../lib/role-shadow/g3-cli";
import { PINNED } from "../lib/role-shadow/spec";
import { loadCalibrationOutcomes, scopesOf } from "../lib/persistence/supabase/role-shadow-outcomes";
import { FakeRest } from "./fixtures/fake-rest";
import { liveRecord } from "./fixtures/role-shadow";
import { synth } from "./fixtures/role-shadow-synth";

function memIO(now = "2026-12-01T00:00:00.000Z"): CliIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files, exists: (p) => files.has(p), read: (p) => { const v = files.get(p); if (v == null) throw new Error(`ENOENT ${p}`); return v; },
    write: (p, d) => void files.set(p, d), append: (p, d) => void files.set(p, (files.get(p) ?? "") + d), mkdirp: () => undefined, now: () => now,
  };
}
const ARGS = { out: "out", log: "log.jsonl", acknowledgeRepeatLook: false, noLog: false };
const loaders = (b: G3Bundle) => ({ records: async () => b.records, outcomes: async () => b.outcomes });
const strong = () => synth({ weeks: [1, 2, 3, 4, 5, 6], perPosition: 80, effect: 2.5, noise: 2, featureScale: 0.3, teams: 2 });

describe("look policy", () => {
  it("an INTERIM (insufficient) evaluation writes its bundle and report but is NOT logged — it can be repeated freely, and says it is descriptive", async () => {
    const io = memIO();
    const small = synth({ weeks: [1, 2], perPosition: 10, effect: 1, noise: 3 });
    const r = await runG3(ARGS, io, loaders(small));
    assert.equal(r.exit, 0);
    assert.equal(r.report!.look, "INTERIM_DESCRIPTIVE");
    assert.equal(r.logged, false);
    assert.equal(io.files.has("log.jsonl"), false);
    assert.ok(io.files.has("out/bundle.json") && io.files.has("out/report.json"));
    for (let i = 0; i < 3; i++) assert.equal((await runG3(ARGS, io, loaders(small))).exit, 0);
  });

  it("the first DECISION look is logged; a SECOND look at the same model is REFUSED (exit 3) and overwrites nothing", async () => {
    const io = memIO();
    const data = strong();
    const first = await runG3(ARGS, io, loaders(data));
    assert.equal(first.exit, 0);
    assert.equal(first.report!.look, "DECISION");
    assert.equal(first.logged, true);
    const reportBefore = io.files.get("out/report.json");
    const logBefore = io.files.get("log.jsonl");
    const second = await runG3(ARGS, io, loaders(synth({ weeks: [1, 2, 3, 4, 5, 6, 7], perPosition: 80, effect: 2.5, noise: 2, featureScale: 0.3, teams: 2, seed: 99 })));
    assert.equal(second.exit, 3);
    assert.equal(second.report, null);
    assert.match(second.message, /REFUSED.*already logged/);
    assert.equal(io.files.get("out/report.json"), reportBefore, "the logged report is untouched");
    assert.equal(io.files.get("log.jsonl"), logBefore, "no new log entry");
  });

  it("an explicitly acknowledged repeat is allowed but is LABELED REPEATED_LOOK in the report and the log", async () => {
    const io = memIO();
    const data = strong();
    await runG3(ARGS, io, loaders(data));
    const again = await runG3({ ...ARGS, acknowledgeRepeatLook: true }, io, loaders(data));
    assert.equal(again.exit, 0);
    assert.match(again.report!.notes.join(" "), /REPEATED_LOOK/);
    const log = readRunLog(io, "log.jsonl");
    assert.equal(log.length, 2);
    assert.deepEqual(log.map((l) => l.repeated_look), [false, true]);
  });

  it("a prior look at ANOTHER model version never blocks this one; --no-log suppresses logging", async () => {
    const io = memIO();
    io.files.set("log.jsonl", JSON.stringify({ at: "x", challenger_config_hash: "d".repeat(32), verdict: "G3_FAIL", report_digest: "r", bundle_sha256: "b", repeated_look: false }) + "\n");
    const r = await runG3(ARGS, io, loaders(strong()));
    assert.equal(r.exit, 0);
    const io2 = memIO();
    const r2 = await runG3({ ...ARGS, noLog: true }, io2, loaders(strong()));
    assert.equal(r2.logged, false);
    assert.equal(io2.files.has("log.jsonl"), false);
  });

  it("the logged entry identifies the model, the verdict, the report digest and the exact input bundle hash", async () => {
    const io = memIO("2026-12-25T10:00:00.000Z");
    const r = await runG3(ARGS, io, loaders(strong()));
    const [e] = readRunLog(io, "log.jsonl");
    assert.deepEqual(e, { at: "2026-12-25T10:00:00.000Z", challenger_config_hash: PINNED.challenger_config_hash, verdict: r.report!.verdict, report_digest: r.report!.report_digest, bundle_sha256: r.bundle_sha256, repeated_look: false });
  });
});

describe("reproducibility", () => {
  it("the written bundle re-evaluates OFFLINE to the byte-identical report (same digest)", async () => {
    const io = memIO();
    const r = await runG3(ARGS, io, loaders(strong()));
    const bundle = JSON.parse(io.files.get("out/bundle.json")!) as G3Bundle;
    assert.equal(evaluateG3(bundle).report_digest, r.report!.report_digest);
    assert.equal(JSON.stringify(evaluateG3(bundle)), JSON.stringify(JSON.parse(io.files.get("out/report.json")!)), "identical report, not just digest");
  });
});

describe("calibration-ledger outcomes loader (read-only)", () => {
  const VIEW = "bridge_calibration_cases_current";
  const row = (i: number, over: Record<string, unknown> = {}) => ({ league_slug: "bloodline-bowl", season: 2026, week: 6, canonical_player_id: `p${i}`, case_id: `cc:${i}`, evidence_digest: `d${i}`, actual_fantasy_points: "12.50", participation_state: "PLAYED_NORMAL", evidence_status: "CERTIFIED", actual_scoring_exactness: "LEAGUE_EXACT", ...over });

  it("reads only the scopes the records cover, maps the ledger's own certification through unchanged, and converts numerics", async () => {
    const fake = new FakeRest();
    fake.t(VIEW).push(row(1), row(2, { actual_fantasy_points: null, participation_state: "DID_NOT_PLAY", evidence_status: "CERTIFIED" }), row(3, { evidence_status: "CERTIFIED_APPROXIMATE_SCORING", actual_scoring_exactness: "PROVIDER_STANDARD_APPROXIMATION" }), row(4, { week: 7 }), row(5, { league_slug: "other" }));
    const records = [liveRecord()];
    assert.deepEqual(scopesOf(records), [{ league_slug: "bloodline-bowl", season: 2026, week: 6 }]);
    const out = await loadCalibrationOutcomes(fake.asRest(), records);
    assert.deepEqual(out.map((o) => o.canonical_player_id).sort(), ["p1", "p2", "p3"], "other weeks / leagues are not read");
    const byId = Object.fromEntries(out.map((o) => [o.canonical_player_id, o]));
    assert.equal(byId.p1!.actual_fantasy_points, 12.5);
    assert.equal(byId.p2!.actual_fantasy_points, null);
    assert.equal(byId.p3!.evidence_status, "CERTIFIED_APPROXIMATE_SCORING", "an approximation is never relabeled as certified");
    assert.equal(byId.p1!.case_ref, "cc:1:d1");
  });

  it("pages past 1000 rows; never issues a write", async () => {
    const fake = new FakeRest();
    for (let i = 0; i < 1203; i++) fake.t(VIEW).push(row(i));
    const out = await loadCalibrationOutcomes(fake.asRest(), [liveRecord()]);
    assert.equal(out.length, 1203);
    assert.ok(fake.selects.every((s) => s.table === VIEW));
    assert.equal(fake.requests, fake.selects.length, "only SELECT requests were made");
  });
});
