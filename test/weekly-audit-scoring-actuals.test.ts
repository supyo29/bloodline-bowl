/**
 * Phase 9 Step 7 / Phase 6 compatibility gate 11 — actual-points scoring reuses Phase 6's engine verbatim.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { actualPointsForOffense, actualPointsForKdst, actualPointsFor, sleeperIdFromCanonical } from "@/lib/weekly-audit/scoring-actuals";

const PPR = { pass_yd: 0.04, pass_td: 4, rec: 1, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6 };

describe("actual points — offense (league-rescored, Phase 6 engine reused verbatim)", () => {
  test("hand-computed: 5 rec, 60 rec_yd, 1 rec_td -> 5*1 + 60*0.1 + 1*6 = 17", () => {
    const r = actualPointsForOffense("WR", { rec: 5, rec_yd: 60, rec_td: 1 }, PPR);
    assert.equal(r.basis, "LEAGUE_RESCORED"); assert.equal(r.points, 17);
  });
  test("a published row with ONLY pts_* (no component stats) is a REAL ZERO, not missing data", () => {
    const r = actualPointsForOffense("WR", { pts_ppr: 4.2 }, PPR);
    assert.equal(r.basis, "REAL_ZERO_NO_STATS"); assert.equal(r.points, 0);
  });
  test("no stat row at all -> UNAVAILABLE, never defaulted to 0", () => {
    const r = actualPointsForOffense("WR", undefined, PPR);
    assert.equal(r.basis, "UNAVAILABLE"); assert.equal(r.points, null);
  });
  test("two different leagues score the identical stat line differently", () => {
    const std = actualPointsForOffense("WR", { rec: 5, rec_yd: 60 }, { ...PPR, rec: 0 });
    const ppr = actualPointsForOffense("WR", { rec: 5, rec_yd: 60 }, PPR);
    assert.equal(std.points, 6); assert.equal(ppr.points, 11);
  });
});

describe("actual points — K/DST (Phase 6 boundary: provider standard points, never league-rescored)", () => {
  test("uses pts_std verbatim and carries the identical production warning string", () => {
    const r = actualPointsForKdst({ pts_std: 8, fgm: 2 });
    assert.equal(r.basis, "PROVIDER_STANDARD_POINTS_KDST"); assert.equal(r.points, 8);
    assert.ok(r.warnings.includes("k_dst_uses_sleeper_standard_points (league-specific weekly K/DST scoring not reconstructable)"));
  });
  test("no stat row -> UNAVAILABLE", () => { assert.equal(actualPointsForKdst(undefined).basis, "UNAVAILABLE"); });
  test("row present but pts_std missing -> UNAVAILABLE, not a guessed 0", () => { assert.equal(actualPointsForKdst({ fgm: 2 }).basis, "UNAVAILABLE"); });
  test("dispatch: K/DEF never goes through the league-rescoring path even if raw_scoring is supplied", () => {
    const r = actualPointsFor("DEF", { def_td: 1 }, { pts_std: 12 }, { def_td: 6 }); // if this used raw_scoring it would be 6, not 12
    assert.equal(r.basis, "PROVIDER_STANDARD_POINTS_KDST"); assert.equal(r.points, 12);
  });
});

describe("identity extraction", () => {
  test("player:sleeper:<id> resolves; any other scheme is null, never guessed", () => {
    assert.equal(sleeperIdFromCanonical("player:sleeper:10222"), "10222");
    assert.equal(sleeperIdFromCanonical("player:gsis:00-0039075"), null);
    assert.equal(sleeperIdFromCanonical("player:sleeper:jax"), "jax");
  });
});
