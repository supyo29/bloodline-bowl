/**
 * PHASE 5 — market consensus + calibrated snake-survival model
 * (`market_consensus_version: ri-snake-market-2026.1`,
 *  `survival_version: ri-snake-survival-2026.1`).
 *
 * Deterministic. Covers §38: crosswalk, degraded fallback, source disagreement,
 * conditional survival, monotonicity, falling-player conditioning, tier
 * survival, BijiMac 12/13 → 36/37 horizon, provenance, version separation,
 * auction exclusion.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildMarketConsensus,
  MARKET_CONSENSUS_VERSION,
  searchRankToPick,
} from "@/lib/draft/market";
import {
  buildMarketConsensusSnapshot,
  buildMarketSnapshot,
  estimateSurvival,
  estimateTierSurvival,
  normalCdf,
  survivalSigma,
  SURVIVAL_MODEL_VERSION,
  SIGMA_CAP,
} from "@/lib/draft/survival";
import { MARKET_ADP_2026 } from "@/lib/draft/data/market-adp-2026";
import { PROJECTION_MODEL_VERSION } from "@/lib/projections/schema";
import { RECOMMENDATION_MODEL_VERSION } from "@/lib/draft/schema";

/* ------------------------------------------------------------- vendored data */

describe("§4/§6 market data + crosswalk", () => {
  it("the vendored ADP snapshot is well-formed and auction-free (§5)", () => {
    assert.equal(MARKET_ADP_2026.market_consensus_version, "ri-snake-market-2026.1");
    assert.ok(MARKET_ADP_2026.players.length > 150);
    // no auction dollar values ever enter the snapshot
    for (const p of MARKET_ADP_2026.players) {
      for (const s of p.sources) {
        assert.ok(s.type === "DIRECT_ADP" || s.type === "RANKING_PROXY", `${s.source} type ${s.type}`);
        assert.ok(s.pick > 0 && s.pick < 400, `${p.name} ${s.source} pick ${s.pick}`);
      }
    }
    // auction sources are explicitly listed as excluded
    assert.ok(MARKET_ADP_2026.excluded_sources.some((e) => /auction/i.test(e.source)));
  });

  it("identity audit reports zero ambiguous rows (§6)", () => {
    assert.equal(MARKET_ADP_2026.identity_audit.ambiguous, 0);
    assert.ok(
      MARKET_ADP_2026.identity_audit.matched / MARKET_ADP_2026.identity_audit.total > 0.85,
      "≥85% of source rows crosswalked",
    );
  });

  it("consensus resolves top players with tight agreement", () => {
    const table = buildMarketConsensus({ referenceDate: "2026-08-31T00:00:00Z" });
    const gibbs = table.by_player.get("9221"); // Jahmyr Gibbs
    assert.ok(gibbs);
    assert.ok(gibbs!.expected_pick <= 3, `Gibbs expected pick ${gibbs!.expected_pick}`);
    assert.ok(gibbs!.dispersion <= 2, `Gibbs dispersion ${gibbs!.dispersion}`);
    assert.equal(gibbs!.confidence, "HIGH");
  });
});

/* ------------------------------------------------------------- consensus math */

describe("§7/§8 consensus + disagreement", () => {
  it("a player with wide source disagreement gets lower confidence + wider band", () => {
    const table = buildMarketConsensus({ referenceDate: "2026-08-31T00:00:00Z" });
    const rows = [...table.by_player.values()].filter((r) => r.direct_adp_count >= 2);
    const tight = rows.filter((r) => r.dispersion <= 3);
    const wide = rows.filter((r) => r.dispersion >= 12);
    assert.ok(tight.length > 0 && wide.length > 0);
    const tightBand = avg(tight.map((r) => r.pick_range[1] - r.pick_range[0]));
    const wideBand = avg(wide.map((r) => r.pick_range[1] - r.pick_range[0]));
    assert.ok(wideBand > tightBand, `wide band ${wideBand.toFixed(1)} not > tight ${tightBand.toFixed(1)}`);
    // and no HIGH-confidence player has huge disagreement (§39)
    for (const r of rows) if (r.dispersion > 12) assert.notEqual(r.confidence, "HIGH");
  });

  it("stale data can never be HIGH confidence (§9/§39)", () => {
    const table = buildMarketConsensus({ referenceDate: "2027-01-01T00:00:00Z" }); // months later
    for (const r of table.by_player.values()) {
      if (r.freshness === "STALE") assert.notEqual(r.confidence, "HIGH");
    }
    // and everything is at least AGING/STALE that far out
    assert.ok([...table.by_player.values()].every((r) => r.freshness !== "FRESH"));
  });
});

/* ------------------------------------------------------------- S2 model */

describe("§13 S2 distribution survival model", () => {
  it("normalCdf matches known values", () => {
    assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
    assert.ok(Math.abs(normalCdf(1.645) - 0.95) < 1e-3);
    assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-3);
  });

  it("sigma grows with expected pick and dispersion, clamped at the cap", () => {
    assert.ok(survivalSigma(10, 0) < survivalSigma(60, 0));
    assert.ok(survivalSigma(30, 0) < survivalSigma(30, 8));
    assert.equal(survivalSigma(500, 50), SIGMA_CAP);
    assert.ok(survivalSigma(1, 0) >= 3.0);
  });

  it("§39 later market pick ⇒ survival not lower; later target ⇒ not higher", () => {
    const mk = (adp: number) =>
      buildMarketSnapshot({
        adpByPlayer: new Map([["X", adp]]),
        searchRankByPlayer: new Map([["X", null]]),
        timestamp: "t",
        dispersionByPlayer: new Map([["X", 3]]),
      });
    const surv = (adp: number, k: number) =>
      estimateSurvival({ playerId: "X", position: "RB", targetPickOverall: k, interveningPicks: 12, market: mk(adp) }).p_survives_next_pick;
    // later ADP (mu 40 vs 20) → more likely to survive pick 30
    assert.ok(surv(40, 30) >= surv(20, 30) - 1e-9);
    // later target (k 40 vs 20) → less likely to survive
    assert.ok(surv(30, 40) <= surv(30, 20) + 1e-9);
  });

  it("§39 longer horizon survival ≤ shorter horizon survival", () => {
    const market = buildMarketSnapshot({
      adpByPlayer: new Map([["X", 25]]),
      searchRankByPlayer: new Map([["X", null]]),
      timestamp: "t",
    });
    let prev = 1;
    for (const k of [26, 28, 31, 37, 43, 49]) {
      const p = estimateSurvival({
        playerId: "X", position: "WR", targetPickOverall: k, interveningPicks: k - 25,
        currentPickOverall: 25, market,
      }).p_survives_next_pick;
      assert.ok(p <= prev + 1e-9, `survival rose from ${prev} to ${p} at k=${k}`);
      prev = p;
    }
  });
});

/* ------------------------------------------------------------- conditional */

describe("§16/§17/§27 conditional survival + falling player", () => {
  const market = buildMarketSnapshot({
    adpByPlayer: new Map([["FALLER", 18]]),
    searchRankByPlayer: new Map([["FALLER", null]]),
    timestamp: "t",
    dispersionByPlayer: new Map([["FALLER", 4]]),
  });

  it("conditioning on current availability raises every forward probability", () => {
    const uncond = estimateSurvival({
      playerId: "FALLER", position: "WR", targetPickOverall: 36, interveningPicks: 12, market,
    }).p_survives_next_pick;
    const cond20 = estimateSurvival({
      playerId: "FALLER", position: "WR", targetPickOverall: 36, interveningPicks: 12,
      currentPickOverall: 20, market,
    }).p_survives_next_pick;
    const cond30 = estimateSurvival({
      playerId: "FALLER", position: "WR", targetPickOverall: 36, interveningPicks: 6,
      currentPickOverall: 30, market,
    }).p_survives_next_pick;
    // ADP 18 → unconditional survival to 36 is tiny
    assert.ok(uncond < 0.1, `uncond ${uncond}`);
    // still available at 20 → a bit more likely; at 30 → much more likely
    assert.ok(cond20 > uncond, `cond@20 ${cond20} !> uncond ${uncond}`);
    assert.ok(cond30 > cond20, `cond@30 ${cond30} !> cond@20 ${cond20}`);
    // never impossible (§39)
    assert.ok(cond30 <= 1 && cond30 >= 0);
  });

  it("a player already deep in the tail does not produce a division blow-up", () => {
    const p = estimateSurvival({
      playerId: "FALLER", position: "WR", targetPickOverall: 90, interveningPicks: 20,
      currentPickOverall: 85, market,
    });
    assert.ok(Number.isFinite(p.p_survives_next_pick) && p.p_survives_next_pick >= 0 && p.p_survives_next_pick <= 1);
  });
});

/* ------------------------------------------------------------- degraded */

describe("§29 degraded modes + fallback hierarchy", () => {
  it("no DIRECT_ADP → search_rank proxy at LOW confidence", () => {
    const market = buildMarketSnapshot({
      adpByPlayer: null,
      searchRankByPlayer: new Map([["P", 40]]),
      timestamp: "t",
    });
    const e = estimateSurvival({ playerId: "P", position: "RB", targetPickOverall: 55, interveningPicks: 14, market });
    assert.equal(e.source, "sleeper_search_rank");
    assert.equal(e.confidence, "LOW");
    assert.ok(e.p_survives_next_pick >= 0 && e.p_survives_next_pick <= 1);
  });

  it("no signal at all → demand-only, still returns a probability", () => {
    const market = buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: new Map(), timestamp: null });
    const e = estimateSurvival({ playerId: "GHOST", position: "TE", targetPickOverall: 20, interveningPicks: 8, market });
    assert.equal(e.source, "positional_demand_only");
    assert.equal(e.confidence, "LOW");
    assert.ok(Number.isFinite(e.p_survives_next_pick));
  });

  it("the real consensus snapshot degrades gracefully for an unknown player", () => {
    const snap = buildMarketConsensusSnapshot({ searchRankByPlayer: new Map([["not-a-real-id", 5]]) });
    const entry = snap.by_player.get("not-a-real-id");
    assert.ok(entry);
    assert.equal(entry!.expected_pick, null);
    assert.equal(entry!.confidence, "LOW");
  });
});

/* ------------------------------------------------------------- tier survival */

describe("§18/§39 tier survival", () => {
  it("more remaining same-tier players never lowers tier-survival probability", () => {
    const base = { position: "WR" as const, tier: 2, expectedPositionDemand: 3, confidence: "MEDIUM" as const };
    const two = estimateTierSurvival({ ...base, memberSurvival: [0.4, 0.4] }).p_tier_survives_next_pick;
    const four = estimateTierSurvival({ ...base, memberSurvival: [0.4, 0.4, 0.4, 0.4] }).p_tier_survives_next_pick;
    assert.ok(four >= two - 1e-9, `4 members ${four} < 2 members ${two}`);
  });

  it("one player before a cliff → low tier survival; three interchangeable → high", () => {
    const one = estimateTierSurvival({
      position: "TE", tier: 1, memberSurvival: [0.2], expectedPositionDemand: 1.5, confidence: "MEDIUM",
    }).p_tier_survives_next_pick;
    const three = estimateTierSurvival({
      position: "WR", tier: 3, memberSurvival: [0.7, 0.7, 0.7], expectedPositionDemand: 1, confidence: "MEDIUM",
    }).p_tier_survives_next_pick;
    assert.ok(one < 0.4);
    assert.ok(three > 0.6);
  });
});

/* ------------------------------------------------------------- BijiMac */

describe("§25 BijiMac slot-12 opening turn horizon (12/13 → 36/37)", () => {
  it("survival to pick 36 from availability at pick 12 is coherent across the board", () => {
    const table = buildMarketConsensus({ referenceDate: "2026-08-31T00:00:00Z" });
    const snap = buildMarketConsensusSnapshot({
      searchRankByPlayer: new Map([...table.by_player.keys()].map((id) => [id, null])),
      consensus: table,
    });
    const inRange = [...table.by_player.values()]
      .filter((r) => r.expected_pick >= 10 && r.expected_pick <= 55)
      .sort((a, b) => a.expected_pick - b.expected_pick);
    assert.ok(inRange.length >= 10);

    const rows = inRange.map((r) => {
      const e = estimateSurvival({
        playerId: r.sleeper_id, position: (r.position ?? "WR") as "WR",
        targetPickOverall: 36, interveningPicks: 23, currentPickOverall: 12, market: snap,
      });
      return { adp: r.expected_pick, name: r.name, p: e.p_survives_next_pick };
    });
    // survival to pick 36 rises with ADP across the board (strong rank correlation)
    const rho = spearman(rows.map((x) => x.adp), rows.map((x) => x.p));
    assert.ok(rho > 0.8, `ADP↔P(survive 36) correlation only ${rho.toFixed(2)}`);
    // an ADP-≤13 player is very unlikely to last to 36; an ADP-≥48 player likely
    for (const x of rows) {
      if (x.adp <= 13) assert.ok(x.p < 0.3, `${x.name} (ADP ${x.adp}) survives 36 at ${x.p}`);
      if (x.adp >= 48) assert.ok(x.p > 0.35, `${x.name} (ADP ${x.adp}) survives 36 only ${x.p}`);
    }
  });
});

/* ------------------------------------------------------------- provenance */

describe("§30/§31 provenance + version separation", () => {
  it("survival, market, recommendation and projection versions are independent constants", () => {
    assert.equal(SURVIVAL_MODEL_VERSION, "ri-snake-survival-2026.1");
    assert.equal(MARKET_CONSENSUS_VERSION, "ri-snake-market-2026.1");
    assert.equal(RECOMMENDATION_MODEL_VERSION, "ri-snake-decision-2026.1");
    assert.equal(PROJECTION_MODEL_VERSION, "ri-structural-2026.3");
    // four distinct namespaces
    assert.equal(new Set([SURVIVAL_MODEL_VERSION, MARKET_CONSENSUS_VERSION, RECOMMENDATION_MODEL_VERSION, PROJECTION_MODEL_VERSION]).size, 4);
  });

  it("every estimate carries source, confidence, timestamp and a traceable note", () => {
    const market = buildMarketSnapshot({
      adpByPlayer: new Map([["X", 20]]), searchRankByPlayer: new Map([["X", 22]]),
      timestamp: "2026-08-31T00:00:00Z", dispersionByPlayer: new Map([["X", 5]]),
    });
    const e = estimateSurvival({
      playerId: "X", position: "RB", targetPickOverall: 30, interveningPicks: 10, currentPickOverall: 15, market,
    });
    assert.equal(e.source, "ranking_pack_adp");
    assert.ok(e.market_timestamp);
    assert.match(e.note, /D~N\(20\.0, /);
    assert.match(e.note, /conditioned on available at pick 15/);
    assert.ok(e.expected_pick_window);
  });
});

/* ------------------------------------------------------------- helpers */

describe("searchRankToPick", () => {
  it("is identity in the top 180 and mildly stretched beyond", () => {
    assert.equal(searchRankToPick(1), 1);
    assert.equal(searchRankToPick(150), 150);
    assert.ok(searchRankToPick(220) > 220);
  });
});

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function rank(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  idx.forEach(([, i], k) => (r[i] = k));
  return r;
}
function spearman(a: number[], b: number[]): number {
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const ma = avg(ra);
  const mb = avg(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}
