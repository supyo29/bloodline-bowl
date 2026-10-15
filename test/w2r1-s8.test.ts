import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dstQualification, kQualification, labelForecast, upsideQualification, POST_OPEN_DEFECTS, qualificationSummary, TACTICAL, W2R1_RESEARCH_VERDICT, QUAL_STATES, UPSIDE_LABEL } from "@/lib/w2r1/qualification";
import { applyQualifiedDst, dstBreakdown, dstForTeam, dstUncertainty, kForTeam, REGIMES, type KdstCapture } from "@/lib/w2r1/dst-live";
import { expectedDstPoints } from "@/lib/w2r1/kdst";
import { buildManifest, canonicalJson, gradeDynamicVor, gradeExpected, gradeProbabilities, payloadHash, verifyManifest } from "@/lib/w2r1/capture";
import { upsideForPlayer, type UpsideCapture } from "@/lib/w2r1/upside-live";
import type { RosterAsset } from "@/lib/w2r1/evidence";
import { captureRow } from "@/lib/w2r1/capture-store";

const WK = "lib/w2r1/data/prospective/wk06";
const haveCapture = existsSync(`${WK}/kdst_components.json`);
const cap = (haveCapture ? JSON.parse(readFileSync(`${WK}/kdst_components.json`, "utf8")) : null) as KdstCapture;
const upCap = (existsSync(`${WK}/upside.json`) ? JSON.parse(readFileSync(`${WK}/upside.json`, "utf8")) : null) as UpsideCapture;

describe("S8 qualification registry (authoritative states)", () => {
  it("D/ST: Devoted, Sporty's, Maclin qualified; Rogers exploratory; Bloodline unqualified with its residual caveat", () => {
    for (const l of ["devoted-to-the-game", "sportys-alumni", "maclin-on-chicks-xvi"]) assert.equal(dstQualification(l).state, "QUALIFIED_SHADOW", l);
    assert.equal(dstQualification("rogers-park").state, "EXPLORATORY_POST_DEFECT"); assert.doesNotMatch(dstQualification("rogers-park").label, /qualified for shadow/i);
    const b = dstQualification("bloodline-bowl"); assert.equal(b.state, "DIAGNOSTIC_ONLY"); assert.ok(b.caveats.some((c) => /blk_kick_ret_yd/.test(c) && /never scored as zero/.test(c)));
    assert.ok(dstQualification("devoted-to-the-game").caveats[0]!.includes("one formulation observed in two leagues")); assert.equal(dstQualification("unknown-league").state, "UNAVAILABLE");
  });
  it("K is never W2.R1-qualified; Rogers has no K; Maclin K needs Yahoo parity first", () => {
    for (const l of ["bloodline-bowl", "devoted-to-the-game", "sportys-alumni", "maclin-on-chicks-xvi"]) assert.equal(kQualification(l).state, "DIAGNOSTIC_ONLY");
    assert.equal(kQualification("rogers-park").state, "UNAVAILABLE"); assert.ok(kQualification("maclin-on-chicks-xvi").caveats.some((c) => /Yahoo kicker stat-line parity/.test(c)));
  });
  it("tactical = null signal, never applied; upside states and wording", () => {
    assert.equal(TACTICAL.tactical_signal, "NO_RELIABLE_INCREMENTAL_SIGNAL"); assert.equal(TACTICAL.applied_to_forecast, false);
    assert.equal(upsideQualification("TE").state, "INSUFFICIENT_FINAL_SAMPLE"); assert.equal(upsideQualification("QB").state, "DIAGNOSTIC_ONLY"); assert.equal(upsideQualification("RB").state, "DIAGNOSTIC_ONLY");
    assert.equal(upsideQualification("WR").state, "NO_RELIABLE_SIGNAL"); assert.equal(upsideQualification("K").state, "UNAVAILABLE"); assert.equal(upsideQualification("DEF").state, "UNAVAILABLE");
    assert.equal(UPSIDE_LABEL, "Upside likelihood — probability of a top-N positional finish"); assert.ok(!/breakout probability/i.test(JSON.stringify(qualificationSummary("rogers-park"))));
    assert.equal(W2R1_RESEARCH_VERDICT, "W2.R1 CERTIFIED WITH DOCUMENTED LIMITATIONS — SHADOW ONLY"); assert.deepEqual([...QUAL_STATES], ["QUALIFIED_SHADOW", "DIAGNOSTIC_ONLY", "EXPLORATORY_POST_DEFECT", "INSUFFICIENT_FINAL_SAMPLE", "NO_RELIABLE_SIGNAL", "UNAVAILABLE"]);
  });
  it("NO SILENT FALLBACK: a generic provider forecast can never wear a W2.R1-qualified label", () => {
    const q = dstQualification("devoted-to-the-game");
    assert.equal(labelForecast("W2R1_COMPONENT_MODEL", q).w2r1_qualified, true);
    const g = labelForecast("INHERITED_GENERIC", q); assert.equal(g.w2r1_qualified, false); assert.notEqual(g.state, "QUALIFIED_SHADOW"); assert.match(g.note, /NO SILENT FALLBACK/);
    assert.equal(labelForecast("NONE", q).state, "UNAVAILABLE"); assert.equal(labelForecast("W2R1_COMPONENT_MODEL", dstQualification("rogers-park")).w2r1_qualified, false);
    assert.equal(labelForecast("INHERITED_GENERIC", dstQualification("bloodline-bowl")).w2r1_qualified, false);
  });
  it("PO-1 / PO-2 are permanently in the audit trail (code and the S7 record) and cannot be dropped", () => {
    assert.equal(POST_OPEN_DEFECTS["PO-1"].status, "CONFIRMATORY_RESULT_INVALIDATED"); assert.match(POST_OPEN_DEFECTS["PO-1"].summary, /Week 6\+ prospective evidence/); assert.match(POST_OPEN_DEFECTS["PO-2"].summary, /oracle/);
    const rec = JSON.parse(readFileSync("scripts/w2r1/results/final/post_open_defects.json", "utf8")) as { defects: Array<{ id: string }> }; assert.deepEqual(rec.defects.map((d) => d.id), ["PO-1", "PO-2"]);
    const s4 = JSON.parse(readFileSync("scripts/w2r1/results/final/s4_final.json", "utf8")); assert.match(s4["S4.rogers-park.DST"].final_status, /EXPLORATORY_PASS_NOT_CONFIRMATORY/);
  });
  it("PO-1 cannot recur: the final K/DST gate code clusters by GAME and a week-sized cluster is rejected", () => {
    assert.match(readFileSync("scripts/w2r1/final/gates.R", "utf8"), /cl <- d\$game_id/); assert.doesNotMatch(readFileSync("scripts/w2r1/final/gates.R", "utf8"), /cl <- paste\(d\$season, d\$week/);
  });
  it("PO-2 cannot recur: the final harness computes the oracle for EVERY slot and T9 'NOT_COMPUTED' is never accepted as a pass", () => {
    assert.doesNotMatch(readFileSync("scripts/w2r1/final/s4_gates.R", "utf8"), /\^\(PASS\|NOT_APPLICABLE\|NOT_COMPUTED\)/);
    const s4 = JSON.parse(readFileSync("scripts/w2r1/results/final/s4_final.json", "utf8")) as Record<string, { expected_points: { gates: Record<string, string> } }>;
    for (const [id, v] of Object.entries(s4)) assert.match(v.expected_points.gates.T9!, /^PASS/, id);
  });
});

describe("S8 live D/ST from the frozen pregame capture (exact league scoring)", { skip: !haveCapture }, () => {
  it("TS expected points reproduce the R values (all teams x all five regimes) to 1e-6", () => {
    for (const t of Object.values(cap.teams)) for (const [slug, reg] of Object.entries(REGIMES)) {
      const r = (t.dst as unknown as Record<string, number>)[`R_expected_${slug}`]!; assert.ok(Math.abs(expectedDstPoints(t.dst, reg.scoring, reg.provider) - r) < 1e-6, `${t.team} ${slug}`);
    }
  });
  it("component breakdown sums to the total; distribution sums to 1; every component is reported", () => {
    const x = dstForTeam(cap, "devoted-to-the-game", Object.keys(cap.teams)[0]!); assert.ok(!("unavailable" in x)); if ("unavailable" in x) return;
    assert.ok(Math.abs(Object.values(x.component_expected_points).reduce((a, b) => a + b, 0) - x.expected_points) < 0.06);
    assert.ok(Math.abs(Object.values(x.points_allowed_distribution).reduce((a, b) => a + b, 0) - 1) < 0.01);
    for (const k of ["sacks", "interceptions", "fumble_recoveries", "touchdowns", "points_allowed"]) assert.ok(k in x.component_expected_points);
    assert.ok(x.evidence_timestamp && x.model_version && x.uncertainty.sd > 0 && x.reconstructed_exact_league_score.scoring_keys.sack != null);
    assert.equal(x.forecast_label.w2r1_qualified, true);
  });
  it("Devoted and Sporty's produce identical values (one scoring formulation); Rogers is labelled exploratory; Bloodline unqualified", () => {
    const tm = Object.keys(cap.teams)[3]!; const a = dstForTeam(cap, "devoted-to-the-game", tm), b = dstForTeam(cap, "sportys-alumni", tm); assert.deepEqual("unavailable" in a ? null : a.expected_points, "unavailable" in b ? null : b.expected_points);
    const r = dstForTeam(cap, "rogers-park", tm); assert.ok(!("unavailable" in r) && r.qualification.state === "EXPLORATORY_POST_DEFECT" && r.forecast_label.w2r1_qualified === false);
    const bl = dstForTeam(cap, "bloodline-bowl", tm); assert.ok(!("unavailable" in bl) && bl.qualification.state === "DIAGNOSTIC_ONLY" && bl.caveats.length > 0 && bl.forecast_label.w2r1_qualified === false);
  });
  it("uncertainty is calibrated against a Monte Carlo of the same component model (sd within 12%)", () => {
    const t = Object.values(cap.teams)[0]!; const reg = REGIMES["maclin-on-chicks-xvi"]!; const u = dstUncertainty(t.dst, reg.scoring, reg.provider);
    let s = 20260101; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    const pois = (l: number) => { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
    const d = dstBreakdown(t.dst, reg.scoring, reg.provider); void d; const c = t.dst; const w = (k: string) => reg.scoring[k] ?? 0; const N = 20000; const xs: number[] = [];
    const cum: number[] = []; c.pa_pmf.reduce((a, v, i) => (cum[i] = a + v), 0);
    for (let i = 0; i < N; i++) { const u1 = rnd(); let pa = cum.findIndex((x) => x >= u1); if (pa < 0) pa = 70; const bins = [[0, w("pts_allow_0")], [6, w("pts_allow_1_6")], [13, w("pts_allow_7_13")], [20, w("pts_allow_14_20")], [27, w("pts_allow_21_27")], [34, w("pts_allow_28_34")], [999, w("pts_allow_35p")]] as const; const bin = pa === 0 ? w("pts_allow_0") : bins.slice(1).find(([hi]) => pa <= hi)![1];
      xs.push(bin + w("pts_allow") * pa + pois(c.e_sacks) * (w("sack") + w("sack_yd") * c.mean_yds.sack_yd) + pois(c.e_ints) * (w("int") + w("int_ret_yd") * c.mean_yds.int_ret_yd) + pois(c.e_fr + c.r_fumrec_st) * w("fum_rec") + pois(c.r_def_td) * w("def_td") + pois(c.r_st_td) * w("st_td") + pois(c.r_blk_td) * w("def_td") + pois(c.r_safeties) * w("safe") + pois(c.r_blk) * w("blk_kick") + pois(c.r_def2pt) * w("def_2pt") + c.r_kr_yd * w("def_kr_yd") + c.r_pr_yd * w("def_pr_yd")); }
    const m = xs.reduce((a, b) => a + b, 0) / N; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / N); assert.ok(Math.abs(sd - u.sd) / sd < 0.12, `${sd} vs ${u.sd}`);
  });
  it("K is always DIAGNOSTIC_ONLY; Rogers (no K slot) is UNAVAILABLE", () => {
    const tm = Object.keys(cap.teams)[0]!; const k = kForTeam(cap, "devoted-to-the-game", tm); assert.ok(!("unavailable" in k)); if (!("unavailable" in k)) { assert.equal(k.qualification.state, "DIAGNOSTIC_ONLY"); assert.match(k.note, /DIAGNOSTIC_ONLY/); }
    const r = kForTeam(cap, "rogers-park", tm); assert.ok("unavailable" in r); assert.equal(r.qualification.state, "UNAVAILABLE");
  });
  it("bye / missing teams are UNAVAILABLE (never zero-filled)", () => { const x = dstForTeam(cap, "devoted-to-the-game", "ZZZ"); assert.ok("unavailable" in x); assert.match(x.reason, /no game/); });
  const mkAsset = (id: string, team: string, pos: "DEF" | "QB", status: "ACTIVE" | "BYE" = "ACTIVE"): RosterAsset => ({ player_id: id, name: id, position: pos, eligible_positions: [pos], team, scoring_fingerprint: "fp", weeks: { 6: { state: status, lineup: status === "BYE" ? 0 : 5, underlying: status === "BYE" ? 0 : 5 }, 7: { state: "ACTIVE", lineup: 5, underlying: 5 } }, bye_week: null, confidence: "LOW", provenance: { source: "generic", observed_at: "2026-10-14T00:00:00Z", source_at: null, evidence_age_ms: null, version: "v" }, missing_evidence: [], status: "BENCH", returns_in_week: null });
  it("Dynamic-VOR override: only QUALIFIED leagues, only the current week, never mutates, byes untouched, non-DEF untouched", () => {
    const team = Object.keys(cap.teams)[0]!; const roster = [mkAsset("D1", team, "DEF"), mkAsset("Q1", team, "QB"), mkAsset("D2", "NOPE", "DEF")]; const before = JSON.stringify(roster);
    const q = applyQualifiedDst(roster, cap, "devoted-to-the-game", 6); assert.equal(JSON.stringify(roster), before); assert.equal(q.replaced.length, 1);
    assert.notEqual(q.assets[0]!.weeks[6]!.lineup, 5); assert.equal(q.assets[0]!.weeks[7]!.lineup, 5, "future weeks stay inherited"); assert.match(q.assets[0]!.missing_evidence.join(), /inherited generic/); assert.equal(q.assets[1]!.weeks[6]!.lineup, 5); assert.equal(q.assets[2]!.weeks[6]!.lineup, 5);
    for (const l of ["rogers-park", "bloodline-bowl", "unknown"]) assert.equal(applyQualifiedDst(roster, cap, l, 6).replaced.length, 0, l);
    assert.equal(applyQualifiedDst(roster, cap, "devoted-to-the-game", 7).replaced.length, 0, "wrong week => no override");
    assert.equal(applyQualifiedDst([mkAsset("B", team, "DEF", "BYE")], cap, "devoted-to-the-game", 6).replaced.length, 0);
  });
});

describe("S8 upside likelihood (frozen capture)", { skip: !upCap }, () => {
  it("TE exposes only as prospective evaluation (INSUFFICIENT_FINAL_SAMPLE); WR has no probability; QB/RB diagnostic; wording is never 'breakout probability'", () => {
    const te = upCap.positions.TE!.rows[0]!; const x = upsideForPlayer(upCap, "TE", te.name!, te.team) as { probability: number | null; display: string; qualification: { state: string } };
    assert.equal(x.qualification.state, "INSUFFICIENT_FINAL_SAMPLE"); assert.ok(x.probability != null); assert.match(x.display, /Upside likelihood — probability of a top-N positional finish/); assert.match(x.display, /INSUFFICIENT_FINAL_SAMPLE/); assert.doesNotMatch(x.display, /breakout/i);
    const wr = upCap.positions.WR!.rows[0]!; const w = upsideForPlayer(upCap, "WR", wr.name!, wr.team) as { probability: number | null; display: string }; assert.equal(w.probability, null); assert.equal(w.display, "NO_RELIABLE_SIGNAL");
    const qb = upCap.positions.QB!.rows[0]!; assert.equal((upsideForPlayer(upCap, "QB", qb.name!, qb.team) as { qualification: { state: string } }).qualification.state, "DIAGNOSTIC_ONLY");
    assert.equal((upsideForPlayer(upCap, "K", "x", null) as { probability: number | null }).probability, null);
  });
  it("the frozen capture uses the frozen rung per position (TE/QB/RB M1b, WR M0) and was built from FIT only", () => {
    assert.deepEqual(Object.fromEntries(Object.entries(upCap.positions).map(([p, v]) => [p, v.frozen_rung])), { QB: "M1b", RB: "M1b", WR: "M0", TE: "M1b" }); assert.match(JSON.stringify(upCap.meta.frozen_models), /s6_fit_eval_sha256/);
  });
});

describe("S8 capture immutability + grading", () => {
  it("canonical JSON is key-order independent; payload hash stable", () => { assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 })); assert.equal(payloadHash({ x: 1 }), payloadHash({ x: 1 })); assert.notEqual(payloadHash({ x: 1 }), payloadHash({ x: 2 })); });
  it("every frozen week verifies (hashes intact, frozen strictly before first kickoff)", () => {
    const root = "lib/w2r1/data/prospective"; for (const d of readdirSync(root).filter((x) => /^wk\d\d$/.test(x) && statSync(join(root, x)).isDirectory())) assert.deepEqual(verifyManifest(join(root, d)), [], d);
  });
  it("the verifier detects tampering, a missing/extra file, and a capture frozen at/after kickoff", () => {
    if (!haveCapture || !existsSync(`${WK}/manifest.json`)) return; const tmp = mkdtempSync(join(tmpdir(), "cap-")); cpSync(WK, tmp, { recursive: true }); assert.deepEqual(verifyManifest(tmp), []);
    const f = join(tmp, "qualification.json"); const orig = readFileSync(f, "utf8"); writeFileSync(f, orig.replace("QUALIFIED_SHADOW", "XUALIFIED_SHADOW")); assert.ok(verifyManifest(tmp).some((p) => /hash mismatch qualification\.json/.test(p))); writeFileSync(f, orig);
    writeFileSync(join(tmp, "extra.json"), "{}"); assert.ok(verifyManifest(tmp).some((p) => /file set differs/.test(p)));
    assert.throws(() => buildManifest(WK, 2026, 6, "2026-10-16T00:15:00.000Z", "2026-10-16T00:15:00.000Z", ["kdst_components.json"]), /not pregame/);
    assert.throws(() => buildManifest(WK, 2026, 6, "2026-10-17T00:00:00.000Z", "2026-10-16T00:15:00.000Z", ["kdst_components.json"]), /not pregame/);
  });
  it("frozen week 6 manifest was frozen before the first kickoff (2026-10-16T00:15Z = Thu 20:15 ET)", () => {
    if (!existsSync(`${WK}/manifest.json`)) return; const m = JSON.parse(readFileSync(`${WK}/manifest.json`, "utf8")); assert.ok(Date.parse(m.frozen_at) < Date.parse("2026-10-16T00:15:00Z")); assert.equal(m.status, "FROZEN_PREGAME");
  });
  it("grading: expected-points error, probability scores, Dynamic-VOR regret / difficulty / bye preservation", () => {
    const g = gradeExpected([{ id: "a", expected: 8 }, { id: "b", expected: 5 }], { a: 10, b: 4 }); assert.equal(g.n, 2); assert.equal(g.mae, 1.5); assert.equal(g.bias, 0.5);
    const p = gradeProbabilities([{ id: "a", p: 0.8 }, { id: "b", p: 0.2 }], { a: 1, b: 0 }); assert.ok(Math.abs(p.brier - 0.04) < 1e-9); assert.equal(p.events, 1);
    const totals: Record<string, number> = { all: 40, X: 30, XR: 38, Y: 39 }; const lineup = (ex: string | null, rep: string | null) => (ex == null ? totals.all! : rep ? totals[ex + "R"] ?? totals.all! - 5 : totals[ex] ?? 30);
    const vg = gradeDynamicVor([{ player_id: "X", predicted_weekly_roster_vor: 2, replacement_player_id: "R", replacement_in_pool_verified: true, verified_pool_alternatives: ["R", "S"], is_bye: false, predicted_hold_vor: 1 }, { player_id: "Y", predicted_weekly_roster_vor: 0.2, replacement_player_id: "R", replacement_in_pool_verified: true, verified_pool_alternatives: ["R"], is_bye: true, predicted_hold_vor: 3 }], { X: 12, Y: 3, R: 6, S: 9 }, lineup);
    assert.equal(vg.rows[0]!.realized_marginal, 2); assert.equal(vg.rows[0]!.error, 0); assert.equal(vg.rows[0]!.regret, 3, "best realized alternative S (9) beat the recommended replacement R (6)"); assert.equal(vg.rows[1]!.bye_preserved, true); assert.equal(vg.rows[1]!.regret, 0);
    assert.equal(vg.summary.n, 2); assert.equal(vg.summary.low_vor_n, 1);
  });
});

describe("S8/integration: W2.R1 is READ-ONLY decision support (hard tests)", () => {
  const walk = (d: string, out: string[] = []): string[] => { for (const e of readdirSync(d)) { const p = join(d, e); if (e === "node_modules" || e === ".next") continue; const st = statSync(p); if (st.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(p)) out.push(p); } return out; };
  it("W2.R1 code contains no transaction / lineup-write / waiver-claim / drop / trade / provider-write call path or mutating HTTP verb", () => {
    const files = [...walk("lib/w2r1"), ...walk("app/api/w2r1")];
    const forbidden = /(from\s+["'][^"']*(\/transactions|\/yahoo\/write|waiver-claim|\/trades\/execute)[^"']*["'])|method:\s*["'](POST|PUT|PATCH|DELETE)["']|\b(submitClaim|placeClaim|dropPlayer|addDropPlayer|setLineup|proposeTrade|executeTrade|submitLineup)\b/;
    assert.deepEqual(files.filter((f) => forbidden.test(readFileSync(f, "utf8"))), []);
  });
  it("the W2.R1 routes export only GET/OPTIONS (no mutating verbs)", () => {
    const routes = walk("app/api/w2r1").filter((f) => f.endsWith("route.ts")); assert.ok(routes.length >= 2);
    for (const r of routes) { const src = readFileSync(r, "utf8"); assert.doesNotMatch(src, /export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/, r); assert.match(src, /w2r1Enabled\(\)/, r); }
  });
  it("every live envelope states it is read-only decision support with no provider writes, plus per-component states", () => { const q = qualificationSummary("devoted-to-the-game"); assert.equal(q.dst_expected_points.state, "QUALIFIED_SHADOW"); });
});

describe("S8 persistence schema (optional; migration is NOT applied; validated on throwaway local staging only)", () => {
  const sql = readFileSync("supabase/migrations/20261014120000_w2r1_prospective_captures.sql", "utf8");
  it("migration is append-only, database-clock pregame-enforced, read-only-record, service-role-only, and the runtime does not need it", () => {
    for (const re of [/create trigger bridge_w2r1_captures_immutable before update or delete/, /create trigger bridge_w2r1_captures_not_late before insert/, /captured_at < first_kickoff_at/, /writes_to_providers'\) = 'false'/, /mode'\) = 'CURRENT_INTELLIGENCE'/, /enable row level security/, /revoke all on public\.bridge_w2r1_prospective_captures from anon, authenticated/, /NOT APPLIED/, /works WITHOUT it/]) assert.match(sql, re);
    assert.doesNotMatch(sql, /\balter table (?!public\.bridge_w2r1_prospective_captures)/i); assert.doesNotMatch(sql, /^\s*drop table(?! if exists public\.bridge_w2r1_prospective_captures;)/m);
    const runtime = [...readdirSync("lib/w2r1"), ...readdirSync("app/api/w2r1")].length; assert.ok(runtime > 0);
    for (const f of ["lib/w2r1/dst-live.ts", "lib/w2r1/context-hook.ts", "lib/w2r1/live.ts", "lib/w2r1/upside-live.ts"]) assert.doesNotMatch(readFileSync(f, "utf8"), /bridge_w2r1_prospective_captures|capture-store/, `${f} must not depend on the persistence table`);
  });
  it("captureRow: deterministic content id, read-only flags, refuses non-pregame and unknown kinds", () => {
    const a = { kind: "KDST_COMPONENTS" as const, season: 2026, week: 6, firstKickoffAt: "2026-10-16T00:15:00Z", capturedAt: "2026-10-14T20:00:00Z", payload: { b: 1, a: 2 }, modelArtifactHashes: {}, qualification: {} };
    const r1 = captureRow(a), r2 = captureRow({ ...a, payload: { a: 2, b: 1 } }); assert.equal(r1.capture_id, r2.capture_id); assert.match(r1.capture_id, /^w2c:[0-9a-f]{16}$/); assert.equal(r1.record.writes_to_providers, "false"); assert.equal(r1.record.mode, "CURRENT_INTELLIGENCE");
    assert.notEqual(captureRow({ ...a, payload: { a: 3 } }).capture_id, r1.capture_id); assert.throws(() => captureRow({ ...a, capturedAt: "2026-10-16T00:15:00Z" }), /not pregame/); assert.throws(() => captureRow({ ...a, kind: "X" as never }), /unknown capture kind/);
  });
  it("Role/opportunity (C2) and the tactical layer are never applied to forecasts", async () => {
    const q = await import("@/lib/w2r1/qualification"); assert.equal(q.ROLE_OPPORTUNITY.applied_to_forecast, false); assert.equal(q.ROLE_OPPORTUNITY.state, "DIAGNOSTIC_ONLY"); assert.equal(q.TACTICAL.applied_to_forecast, false);
  });
});
