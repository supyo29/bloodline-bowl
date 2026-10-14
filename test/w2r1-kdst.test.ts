import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dWeights, expectedDstPoints, expectedKPoints, kWeights, paScore, unsupportedKdstKeys, type DComponents, type KComponents, type Scoring } from "@/lib/w2r1/kdst";

interface Golden { scoring: Scoring; comp: unknown; expected: number }
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
          : expectedDstPoints({ ...(r.comp as DComponents), pa_pmf: arr((r.comp as DComponents).pa_pmf) }, scoring);
        assert.ok(Math.abs(got - arr(r.expected)[0]!) < 1e-6, `${key}: ${got} vs ${r.expected}`);
      }
    });
  }
  it("flat fgm is ADDED to every bin weight; 50p is used when 50_59 / 60p are absent", () => {
    const k = kWeights({ fgm: 3, fgmiss: -1, fgm_50p: 5, xpm: 1 });
    assert.deepEqual(k.make, [3, 3, 3, 3, 8, 8]); assert.deepEqual(k.miss, [-1, -1, -1, -1, -1, -1]);
  });
  it("points-allowed: bins and the continuous per-point key both apply", () => {
    const d = dWeights({ pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_35p: -4, pts_allow: -0.3 });
    assert.equal(paScore(0, d), 10); assert.equal(paScore(3, d), 7 - 0.9); assert.equal(paScore(40, d), -4 - 12);
  });
  it("a scoring key the model cannot reconstruct is REPORTED, never silently zero-scored", () => {
    assert.deepEqual(unsupportedKdstKeys({ sack: 1, yds_allow_300_349: 2, fgm: 3, bonus_def_int_td_50p: 2 }), ["bonus_def_int_td_50p", "yds_allow_300_349"]);
    assert.deepEqual(unsupportedKdstKeys({ sack: 1, int: 2, pts_allow_0: 10 }), []);
  });
  it("the unsupported / ambiguous key list for every registered regime is EXPLICIT and pinned (regimes are never silently scored as if complete)", () => {
    const regs = JSON.parse(readFileSync("scripts/w2r1/s4_regimes.json", "utf8")).regimes as Record<string, { scoring: Scoring }>;
    const out = Object.fromEntries(Object.entries(regs).map(([k, v]) => [k, unsupportedKdstKeys(v.scoring)]));
    // fum_rec_td: a fumble-recovery TD that may or may not be paid IN ADDITION to def_td by the provider (ambiguous; ~0.03 events/game). def_st_td: combined D/ST TD key the DEF stat line does not carry.
    assert.deepEqual(out, {
      "bloodline-bowl": ["blk_kick_ret_yd", "def_st_td", "fg_ret_yd", "fum_rec_td"],
      "devoted-to-the-game": ["def_st_td", "fum_rec_td"], "sportys-alumni": ["def_st_td", "fum_rec_td"],
      "maclin-on-chicks-xvi": ["fum_rec_td"], "rogers-park": ["fum_rec_td"],
    });
  });
});
