import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { computeDynamicVor } from "@/lib/w2r1/vor";
import { computeDynamicVor as fast } from "@/lib/w2r1/generated/vor-fast";
import { cacheStats } from "@/lib/w2r1/scenario-cache";
import { synth } from "../scripts/w2r1/perf/synth";

describe("S9 memoized Dynamic VOR is IDENTICAL to the frozen implementation", () => {
  const cases: Array<[number, Parameters<typeof synth>[1]]> = [[1, {}], [2, { verified: false }], [3, { rosterSize: 14, pool: 40 }], [4, { week: 9, lastWeek: 14 }], [5, { rosterSize: 22, pool: 220 }], [6, { pool: 0 }], [7, { week: 6, lastWeek: 6 }], [8, { rosterSize: 17, pool: 90, week: 8 }]];
  for (const [seed, o] of cases) it(`seed ${seed} ${JSON.stringify(o)}: every roster player deep-equals`, () => {
    const { rules, roster, market } = synth(seed, o); const wk = o?.week ?? 6;
    for (const a of roster) assert.deepEqual(JSON.parse(JSON.stringify(fast({ rules, roster, playerId: a.player_id, week: wk, market }))), JSON.parse(JSON.stringify(computeDynamicVor({ rules, roster, playerId: a.player_id, week: wk, market }))), a.player_id);
  });
  it("the memo is scoped to the request's (rules, roster) object identity: a changed roster object never sees stale values", () => {
    const { rules, roster, market } = synth(11); const a = roster[0]!;
    const before = JSON.stringify(fast({ rules, roster, playerId: a.player_id, week: 6, market }));
    const roster2 = roster.map((x) => (x.player_id === "R3" ? { ...x, weeks: Object.fromEntries(Object.entries(x.weeks).map(([w, v]) => [w, { ...v, lineup: (v.lineup ?? 0) + 40, underlying: (v.underlying ?? 0) + 40 }])) } : x));
    const after = JSON.stringify(fast({ rules, roster: roster2, playerId: a.player_id, week: 6, market }));
    assert.equal(after, JSON.stringify(computeDynamicVor({ rules, roster: roster2, playerId: a.player_id, week: 6, market }))); assert.equal(before, JSON.stringify(computeDynamicVor({ rules, roster, playerId: a.player_id, week: 6, market })));
  });
  it("the memo actually reuses work (hits > 0) and the generated file is exactly the generator's output (never hand-edited)", () => {
    const { rules, roster, market } = synth(12); const h0 = cacheStats.scenarioHits; for (const a of roster) fast({ rules, roster, playerId: a.player_id, week: 6, market }); assert.ok(cacheStats.scenarioHits > h0);
    const on = readFileSync("lib/w2r1/generated/vor-fast.ts", "utf8"); const tmp = join(mkdtempSync(join(tmpdir(), "vf-")), "vor-fast.ts"); execFileSync("python3", ["scripts/w2r1/perf/make_vor_fast.py", tmp]); assert.equal(readFileSync(tmp, "utf8"), on);
  });
  it("performance guard: a realistic 19-player roster / 160-candidate pool / 12-week horizon computes within a generous budget (profiled ~0.47 s vs 0.75 s frozen on the dev machine)", () => {
    const { rules, roster, market } = synth(1); const t0 = performance.now(); for (const a of roster) fast({ rules, roster, playerId: a.player_id, week: 6, market }); assert.ok(performance.now() - t0 < 3000);
  });
});
