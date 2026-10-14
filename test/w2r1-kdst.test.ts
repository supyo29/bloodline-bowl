import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dWeights, expectedDstPoints, expectedKPoints, kWeights, notApplicableDstKeys, paScore, unsupportedKdstKeys, type DComponents, type Provider, type KComponents, type Scoring } from "@/lib/w2r1/kdst";

interface Golden { scoring: Scoring; provider: Provider; comp: unknown; expected: number }
const golden = JSON.parse(readFileSync("scripts/w2r1/results/s4_golden.json", "utf8")) as Record<string, Golden[]>;
// R (jsonlite) writes length-1 vectors as scalars; normalize arrays
const arr = (x: unknown): number[] => (Array.isArray(x) ? (x as number[]) : [x as number]);

describe("W2.R1 S4 exact-scoring K / D-ST expected points (golden-tested against the R implementation)", () => {
  for (const [key, rows] of Object.entries(golden)) {
    it(`${key}: TS reconstruction equals R to 1e-6 on ${rows.length} rows`, () => {
      for (const r of rows) {
        const scoring = r.scoring as Scoring;
        const got = key.endsWith("|K")
          ? expectedKPoints({ ...(r.comp as KComponents), shares: arr((r.comp as KComponents).shares), pbin: arr((r.comp as KComponents).pbin) }, scoring)
          : expectedDstPoints({ ...(r.comp as DComponents), pa_pmf: arr((r.comp as DComponents).pa_pmf) }, scoring, arr(r.provider as unknown as number)[0] as unknown as Provider);
        assert.ok(Math.abs(got - arr(r.expected)[0]!) < 1e-6, `${key}: ${got} vs ${r.expected}`);
      }
    });
  }
  it("flat fgm is ADDED to every bin weight; 50p is used when 50_59 / 60p are absent", () => {
    const k = kWeights({ fgm: 3, fgmiss: -1, fgm_50p: 5, xpm: 1 });
    assert.deepEqual(k.make, [3, 3, 3, 3, 8, 8]); assert.deepEqual(k.miss, [-1, -1, -1, -1, -1, -1]);
  });
  it("points-allowed: bins and the continuous per-point key both apply", () => {
    const d = dWeights({ pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_35p: -4, pts_allow: -0.3 }, "sleeper");
    assert.equal(paScore(0, d), 10); assert.equal(paScore(3, d), 7 - 0.9); assert.equal(paScore(40, d), -4 - 12);
  });
  it("a scoring key the model cannot reconstruct is REPORTED, never silently zero-scored", () => {
    assert.deepEqual(unsupportedKdstKeys({ sack: 1, yds_allow_300_349: 2, fgm: 3, bonus_def_int_td_50p: 2 }, "sleeper"), ["bonus_def_int_td_50p", "yds_allow_300_349"]);
    assert.deepEqual(unsupportedKdstKeys({ sack: 1, bonus_def_int_td_50p: 2 }, "yahoo"), ["bonus_def_int_td_50p"]);
    assert.deepEqual(unsupportedKdstKeys({ sack: 1, int: 2, pts_allow_0: 10 }, "yahoo"), []);
  });
  it("the unsupported / ambiguous key list for every registered regime is EXPLICIT and pinned (regimes are never silently scored as if complete)", () => {
    const regs = JSON.parse(readFileSync("scripts/w2r1/s4_regimes.json", "utf8")).regimes as Record<string, { scoring: Scoring; provider: Provider }>;
    const out = Object.fromEntries(Object.entries(regs).map(([k, v]) => [k, unsupportedKdstKeys(v.scoring, v.provider)]));
    // Only Bloodline's blocked-kick / missed-FG return-yardage keys remain unreconstructable (nflverse does not carry them reliably); quantified in scripts/w2r1/results/s7_kdst_coverage.json and bounded as immaterial there.
    assert.deepEqual(out, {
      "bloodline-bowl": ["blk_kick_ret_yd", "fg_ret_yd"],
      "devoted-to-the-game": [], "sportys-alumni": [], "maclin-on-chicks-xvi": [], "rogers-park": [],
    });
    const na = Object.fromEntries(Object.entries(regs).map(([k, v]) => [k, notApplicableDstKeys(v.scoring, v.provider)]));
    assert.deepEqual(na, {
      "bloodline-bowl": ["fum_rec_td", "kr_yd", "pr_yd", "st_fum_rec", "st_ff", "st_td"].sort(),
      "devoted-to-the-game": ["fum_rec_td", "st_ff", "st_fum_rec", "st_td"].sort(), "sportys-alumni": ["fum_rec_td", "st_ff", "st_fum_rec", "st_td"].sort(),
      "maclin-on-chicks-xvi": ["fum_rec_td", "kr_yd", "pr_yd"], "rogers-park": ["fum_rec_td"],
    });
  });
  it("PROVIDER SEMANTICS: Sleeper keeps defensive and special-teams recoveries / forced fumbles / TDs separate; Yahoo pays one Fumble Recovery for both and has no forced-fumble or fum_rec_td D/ST stat", () => {
    const sc = { fum_rec: 1, def_st_fum_rec: 2, ff: 3, def_st_ff: 4, def_td: 6, def_st_td: 7, st_td: 8, fum_rec_td: 9 };
    const s = dWeights(sc, "sleeper"), y = dWeights(sc, "yahoo");
    assert.deepEqual([s.blk_td, y.blk_td], [7, 6]); // blocked-kick TD: Sleeper def_st_td, Yahoo defensive Touchdown
    assert.deepEqual([s.fumrec_def, s.fumrec_st, s.ff_def, s.ff_st, s.def_td, s.st_td], [1, 2, 3, 4, 6, 7]);
    assert.deepEqual([y.fumrec_def, y.fumrec_st, y.ff_def, y.ff_st, y.def_td, y.st_td], [1, 1, 0, 0, 6, 8]);
  });
});
