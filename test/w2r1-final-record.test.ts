import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { verifyFrozen } from "../scripts/w2r1/s7_verify_frozen";

const J = (p: string) => JSON.parse(readFileSync(p, "utf8"));
describe("W2.R1 S7 final record", () => {
  it("FROZEN.json still verifies after the final evaluation (nothing frozen changed)", () => { assert.deepEqual(verifyFrozen("."), []); });
  const has = existsSync("scripts/w2r1/results/final/s5_final.json");
  it("no S5 report-only candidate was promoted and every one is flagged by the cap gate", () => {
    if (!has) return; const c = J("scripts/w2r1/results/final/s5_final.json").candidates;
    for (const [id, v] of Object.entries(c) as Array<[string, any]>) if (id.startsWith("S5.")) { assert.ok(!/SHADOW_QUALIFIED/.test(v.final_status), id); assert.equal(v.gates.T8, "FAIL", id); assert.ok(v.cap_hit_rate > 0.1, id); }
  });
  it("S6: TE is INSUFFICIENT_FINAL_SAMPLE (events < 40); no position is qualified", () => {
    if (!has) return; const f = J("scripts/w2r1/results/final/s6_final_raw.json").final;
    assert.equal(f.TE.final_status, "INSUFFICIENT_FINAL_SAMPLE"); assert.ok(f.TE.candidate.events < 40);
    for (const p of ["QB", "RB", "WR", "TE"]) assert.notEqual(f[p].final_status, "SHADOW_QUALIFIED");
  });
  it("S4: Rogers Park D/ST is NOT counted as qualified (post-open defect PO-1); the Maclin K slot stays diagnostic", () => {
    if (!has) return; const s = J("scripts/w2r1/results/final/s4_final.json");
    assert.match(s["S4.rogers-park.DST"].final_status, /EXPLORATORY_PASS_NOT_CONFIRMATORY/); assert.equal(s["S4.maclin-on-chicks-xvi.K"].final_status, "DIAGNOSTIC_ONLY");
    for (const [id, v] of Object.entries(s) as Array<[string, any]>) if (id.endsWith(".K")) assert.notEqual(v.final_status, "SHADOW_QUALIFIED", id);
  });
  it("the access log starts after the freeze verification and every event is time-ordered", () => {
    const ev = readFileSync("scripts/w2r1/final/access_log.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l) as { t: string; event: string });
    assert.equal(ev[0]!.event, "FIRST_FINAL_ACCESS"); for (let i = 1; i < ev.length; i++) assert.ok(ev[i]!.t >= ev[i - 1]!.t);
  });
});
