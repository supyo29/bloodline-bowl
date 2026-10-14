import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { confidenceWeight, continuityFactor, describeTendency, ebRate, evidenceStates, expectedFromDelta, interactionTerm, priorGames, redistributeShare, retainLayer, tierBCarryover, tierBColumns } from "@/lib/w2r1/gameplan";
import { readFileSync } from "node:fs";

describe("W2.R1 S5 point-in-time contract", () => {
  const games = [{ season: 2024, week: 17 }, { season: 2025, week: 1 }, { season: 2025, week: 2 }, { season: 2025, week: 3 }, { season: 2025, week: 4 }];
  it("only STRICTLY earlier games are evidence: the target game and every later game are excluded", () => {
    const p = priorGames(games, { season: 2025, week: 3 }, 10);
    assert.deepEqual(p, [{ season: 2024, week: 17 }, { season: 2025, week: 1 }, { season: 2025, week: 2 }]);
  });
  it("a window crossing a season boundary keeps order and the limit", () => { assert.deepEqual(priorGames(games, { season: 2025, week: 4 }, 2), [{ season: 2025, week: 2 }, { season: 2025, week: 3 }].slice(0, 2)); });
  it("empirical-Bayes rate shrinks toward the league mean and ignores unknown games", () => {
    assert.equal(ebRate([], 0.5), 0.5); assert.ok(Math.abs(ebRate([1, 1, 1, 1], 0.5) - 0.75) < 1e-12); assert.equal(ebRate([null, null], 0.3), 0.3);
    assert.ok(ebRate([1, 1], 0, 4, [1, 0]) < ebRate([1, 1], 0, 4, [1, 1]), "a zero-weight (discounted) game contributes nothing");
  });
});

describe("W2.R1 S5 continuity, confidence and missing evidence", () => {
  it("continuity factor: HC change keeps 40%, QB change 60%, both compound; unknown OC/DC/personnel add no discount", () => {
    assert.equal(continuityFactor({ hcSame: true, qbSame: true }), 1); assert.equal(continuityFactor({ hcSame: false }), 0.4); assert.ok(Math.abs(continuityFactor({ hcSame: false, qbSame: false }) - 0.24) < 1e-12); assert.equal(continuityFactor({ hcSame: true, qbSame: false }), 0.6);
  });
  it("missing evidence NEVER becomes a confident adjustment: weight 0 below 2 games", () => { assert.equal(confidenceWeight(0, 10), 0); assert.equal(confidenceWeight(1, 10), 0); assert.equal(confidenceWeight(3, 10), 0.6); assert.equal(confidenceWeight(8, 2), 0.6); assert.equal(confidenceWeight(8, 9), 1); });
  it("evidence states distinguish no / stale / prior-season-only / low-continuity evidence", () => {
    assert.deepEqual(evidenceStates({ currentSeasonGames: 0, totalGames: 0, gapDays: null, continuity: 1 }), ["NO_EVIDENCE"]);
    assert.deepEqual(evidenceStates({ currentSeasonGames: 5, totalGames: 9, gapDays: 30, continuity: 1 }), ["STALE_EVIDENCE"]);
    assert.deepEqual(evidenceStates({ currentSeasonGames: 1, totalGames: 9, gapDays: 7, continuity: 1 }), ["PRIOR_SEASON_ONLY"]);
    assert.deepEqual(evidenceStates({ currentSeasonGames: 6, totalGames: 9, gapDays: 7, continuity: 0.24 }), ["LOW_CONTINUITY"]);
    assert.deepEqual(evidenceStates({ currentSeasonGames: 6, totalGames: 9, gapDays: 7, continuity: 1 }), ["OK"]);
  });
});

describe("W2.R1 S5 tiers: Tier B is prior-season carryover only", () => {
  it("a target-season (or later) Tier-B observation is rejected as unknown, never used as 2026 truth", () => {
    assert.equal(tierBCarryover({ targetSeason: 2026, evidenceSeason: 2026, prior: 0.6, continuity: 1, league: 0.5 }), null);
    assert.equal(tierBCarryover({ targetSeason: 2026, evidenceSeason: 2027, prior: 0.6, continuity: 1, league: 0.5 }), null);
    assert.equal(tierBCarryover({ targetSeason: 2026, evidenceSeason: 2025, prior: null, continuity: 1, league: 0.5 }), null);
  });
  it("carryover is shrunk by continuity, labelled Tier B, observed=false and carries its age", () => {
    const c = tierBCarryover({ targetSeason: 2026, evidenceSeason: 2025, prior: 0.7, continuity: 0.4, league: 0.5 })!;
    assert.ok(Math.abs(c.value - (0.4 * 0.7 + 0.6 * 0.5)) < 1e-12); assert.equal(c.tier, "B"); assert.equal(c.observed, false); assert.equal(c.evidence_age_seasons, 1);
  });
  it("the primary S5 candidate feature lists contain NO Tier-B column (G2b is the only labelled variant)", () => {
    const src = readFileSync("scripts/w2r1/s5_run.ts", "utf8");
    const g2 = src.slice(src.indexOf("const features = "), src.indexOf("/* ---------------- model"));
    assert.ok(g2.includes('case "G2b": return [...g2, ...TIERB]'));
    const nonB = g2.replace('case "G2b": return [...g2, ...TIERB];', "");
    assert.ok(!/TIERB/.test(nonB), "Tier-B features must appear ONLY in the labelled G2b variant");
    assert.deepEqual(tierBColumns(["rl_targets", "t_deep_attempt_rate_CUR", "tbB_man", "tb_off11"]), ["tbB_man", "tb_off11"]);
  });
});

describe("W2.R1 S5 interactions, second-order effects, injury and layer inclusion", () => {
  it("a matchup term is the product of player fingerprint and opponent response: no usage => no effect, unknown => unknown", () => {
    assert.equal(interactionTerm(0, 0.9), 0); assert.equal(interactionTerm(0.4, 0.5), 0.2); assert.equal(interactionTerm(null, 0.5), null);
  });
  it("teammate absence redistributes across ALL teammates in proportion to as-of share (not only a direct backup)", () => {
    const m = redistributeShare(0.2, [{ id: "a", share: 0.3 }, { id: "b", share: 0.1 }, { id: "c", share: 0.1 }]);
    assert.ok(Math.abs(m.get("a")! - 0.12) < 1e-12 && Math.abs(m.get("b")! - 0.04) < 1e-12 && Math.abs(m.get("c")! - 0.04) < 1e-12); assert.ok(Math.abs([...m.values()].reduce((s, v) => s + v, 0) - 0.2) < 1e-12);
  });
  it("availability is applied EXACTLY ONCE (a stub injury layer that halves points is applied a single time)", () => {
    let calls = 0; const inj = (p: number) => { calls++; return p * 0.5; };
    assert.equal(expectedFromDelta(10, 2, inj), 6); assert.equal(calls, 1);
  });
  it("layer inclusion needs BOTH >= 0.03 points and a bootstrap lower bound > 0 (an interaction that does not beat the additive model is rejected)", () => {
    assert.equal(retainLayer(0.05, 0.01), true); assert.equal(retainLayer(0.05, -0.01), false); assert.equal(retainLayer(0.02, 0.01), false); assert.equal(retainLayer(0.03, 0), false);
  });
  it("wording is probabilistic and tier-labelled, never a claim about an unpublished plan", () => {
    const t = describeTendency({ subject: "Opponent pressure", metric: "blitz", value: 0.4, league: 0.3, tier: "A", confidence: "MEDIUM" });
    assert.match(t, /tendency is elevated/); assert.match(t, /confidence: medium/); assert.ok(!/will (run|throw|blitz)/i.test(t));
    assert.match(describeTendency({ subject: "Opponent", metric: "man coverage", value: 0.3, league: 0.3, tier: "B", confidence: "LOW" }), /Prior-season \(carryover\)/);
  });
});
