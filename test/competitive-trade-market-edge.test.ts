/**
 * Competitive Trade Intelligence — Checkpoint B: Market Edge classifier.
 *
 * Tests the pure classifier (`buildMarketEdges`) against SYNTHETIC private /
 * market value maps — no live ranks, no network. Covers spec §21 (B1–B9) and
 * §22 (monotonicity invariants).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { player } from "./fixtures/weekly";
import { buildMarketEdges } from "../lib/trades/competitive/market-edge";
import { resolveCompetitiveTradeConfig } from "../lib/trades/competitive/config";
import type { PlayerPrivateValue } from "../lib/trades/competitive/private-value";
import type { PlayerMarketSnapshot } from "../lib/trades/competitive/market/snapshot";
import type { CanonicalPlayer } from "../lib/canonical/schema";
import type { MarketLineage, MarketReadiness, ValueConfidence } from "../lib/trades/competitive/schema";

const CFG = resolveCompetitiveTradeConfig();

interface Spec {
  id: string;
  pos: string;
  priv: number | null;
  mkt: number | null;
  privConf?: ValueConfidence;
  mktCeiling?: ValueConfidence;
  readiness?: MarketReadiness;
  dispersion?: number;
  corr?: { pct: number; direction: string } | null;
}

function lineage(readiness: MarketReadiness, dispersion: number): MarketLineage {
  return {
    sources: [
      {
        source: "sleeper_projection",
        source_type: "provider_benchmark",
        as_of: "2026-09-08",
        scoring_format: "league_scoring",
        readiness,
        raw_value: 10,
        raw_unit: "weekly_points",
        implied_position_rank: null,
        notes: [],
      },
    ],
    primary_source_type: "provider_benchmark",
    usable_source_count: 1,
    dispersion,
    worst_readiness: readiness,
    scoring_normalization: "test",
  };
}

function run(specs: Spec[]) {
  const players_by_id = new Map<string, CanonicalPlayer>();
  const private_values = new Map<string, PlayerPrivateValue>();
  const market_snapshots = new Map<string, PlayerMarketSnapshot>();
  const universe: string[] = [];

  for (const s of specs) {
    universe.push(s.id);
    players_by_id.set(s.id, player(s.id, s.pos as CanonicalPlayer["position"]));
    private_values.set(s.id, {
      canonical_player_id: s.id,
      position: s.pos,
      raw: s.priv,
      basis: s.priv != null ? "weekly_vor" : "unavailable",
      projected_points: s.priv,
      ri_position_rank: null,
      ri_season_vor: null,
      confidence: s.privConf ?? "HIGH",
      model_version: "test",
      as_of: "2026-09-08",
    });
    const readiness = s.readiness ?? "CURRENT";
    market_snapshots.set(s.id, {
      canonical_player_id: s.id,
      position: s.pos,
      primary_raw: s.mkt,
      primary_basis: s.mkt != null ? "ros_weekly_vor" : "unavailable",
      readiness: s.mkt != null ? readiness : "UNAVAILABLE",
      confidence_ceiling: s.mktCeiling ?? "HIGH",
      scoring_compatible: true,
      corroborating_disagreement: s.corr ?? null,
      lineage: lineage(s.mkt != null ? readiness : "UNAVAILABLE", s.dispersion ?? 0),
    });
  }

  return buildMarketEdges({ private_values, market_snapshots, players_by_id, universe, config: CFG }).by_player;
}

/** A spread-out RB position group so z-scores are well defined. */
function rbGroup(target: { priv: number; mkt: number; extra?: Partial<Spec> }): Spec[] {
  const filler: Spec[] = [];
  for (let i = 0; i < 10; i += 1) {
    filler.push({ id: `rb_filler_${i}`, pos: "RB", priv: 16 - i * 1.6, mkt: 16 - i * 1.6 });
  }
  return [{ id: "TARGET", pos: "RB", priv: target.priv, mkt: target.mkt, ...target.extra }, ...filler];
}

describe("Competitive Trade — Market Edge classifier (Checkpoint B)", () => {
  it("B1 — strong private-over-market gap at HIGH confidence ⇒ STRONG_BUY", () => {
    const edges = run(rbGroup({ priv: 15, mkt: 2 }));
    const e = edges.get("TARGET")!;
    assert.equal(e.direction, "STRONG_BUY");
    assert.ok(e.edge_score! > 0);
    assert.ok(e.actionable_edge! > 0);
    assert.equal(e.analytical_only, true);
    assert.ok(e.reason_codes.includes("PRIVATE_ABOVE_MARKET"));
    assert.ok(e.reason_codes.includes("ANALYTICAL_ONLY_NO_ACQUISITION_MODEL"));
  });

  it("B2 — strong market-over-private gap ⇒ STRONG_SELL", () => {
    const edges = run(rbGroup({ priv: 2, mkt: 15 }));
    const e = edges.get("TARGET")!;
    assert.equal(e.direction, "STRONG_SELL");
    assert.ok(e.edge_score! < 0);
    assert.ok(e.reason_codes.includes("MARKET_ABOVE_PRIVATE"));
  });

  it("B3 — small discrepancy ⇒ FAIR", () => {
    const edges = run(rbGroup({ priv: 8.2, mkt: 8.0 }));
    const e = edges.get("TARGET")!;
    assert.equal(e.direction, "FAIR");
  });

  it("B4 — confidence gate: identical gap, HIGH ranks materially above VERY_LOW and VERY_LOW never STRONG", () => {
    const hi = run(rbGroup({ priv: 15, mkt: 2, extra: { privConf: "HIGH", mktCeiling: "HIGH" } })).get("TARGET")!;
    const lo = run(rbGroup({ priv: 15, mkt: 2, extra: { privConf: "VERY_LOW", mktCeiling: "VERY_LOW" } })).get("TARGET")!;
    assert.equal(hi.edge_score, lo.edge_score, "raw edge_score identical");
    assert.ok(Math.abs(hi.actionable_edge!) > Math.abs(lo.actionable_edge!) * 2, "HIGH is materially more actionable");
    assert.equal(hi.direction, "STRONG_BUY");
    assert.notEqual(lo.direction, "STRONG_BUY");
    assert.ok(["BUY", "FAIR"].includes(lo.direction));
    assert.ok(lo.reason_codes.includes("CONFIDENCE_GATE_APPLIED") || lo.direction !== "STRONG_BUY");
  });

  it("B5 — equal positional-rank gaps at different points of the curve are NOT equal edges", () => {
    // Steep top, flat tail. Two targets each 'one rank' different from their
    // market rank, but at different curve locations ⇒ different z-deltas.
    const specs: Spec[] = [
      { id: "TOP_A", pos: "RB", priv: 30, mkt: 24 }, // steep region: 6-pt raw gap
      { id: "TAIL_A", pos: "RB", priv: 2.5, mkt: 2.0 }, // flat region: 0.5-pt raw gap
      { id: "f0", pos: "RB", priv: 30, mkt: 30 },
      { id: "f1", pos: "RB", priv: 24, mkt: 24 },
      { id: "f2", pos: "RB", priv: 18, mkt: 18 },
      { id: "f3", pos: "RB", priv: 12, mkt: 12 },
      { id: "f4", pos: "RB", priv: 7, mkt: 7 },
      { id: "f5", pos: "RB", priv: 4, mkt: 4 },
      { id: "f6", pos: "RB", priv: 2.5, mkt: 2.5 },
      { id: "f7", pos: "RB", priv: 1.5, mkt: 1.5 },
    ];
    const edges = run(specs);
    const top = edges.get("TOP_A")!;
    const tail = edges.get("TAIL_A")!;
    assert.ok(Math.abs(top.edge_score!) > Math.abs(tail.edge_score!) + 0.2, "steep-region mispricing scores higher");
  });

  it("B6 — missing market data ⇒ INSUFFICIENT_DATA, edge_score null (never a fake zero)", () => {
    const edges = run(rbGroup({ priv: 10, mkt: null as unknown as number }));
    const e = edges.get("TARGET")!;
    assert.equal(e.direction, "INSUFFICIENT_DATA");
    assert.equal(e.edge_score, null);
    assert.equal(e.actionable_edge, null);
    assert.equal(e.market_value, null);
    assert.ok(e.reason_codes.includes("MARKET_DATA_UNAVAILABLE"));
  });

  it("B7 — stale market ⇒ market confidence downgraded, direction capped, lineage preserved", () => {
    const fresh = run(rbGroup({ priv: 15, mkt: 2, extra: { readiness: "CURRENT" } })).get("TARGET")!;
    const stale = run(rbGroup({ priv: 15, mkt: 2, extra: { readiness: "STALE" } })).get("TARGET")!;
    assert.equal(fresh.edge_score, stale.edge_score);
    assert.ok(Math.abs(stale.actionable_edge!) <= Math.abs(fresh.actionable_edge!));
    assert.notEqual(stale.direction, "STRONG_BUY");
    assert.ok(stale.reason_codes.includes("MARKET_DATA_STALE"));
    assert.ok(stale.lineage.sources.length > 0);
  });

  it("B8 — cross-source disagreement lowers market confidence", () => {
    const agree = run(rbGroup({ priv: 15, mkt: 2, extra: { dispersion: 0 } })).get("TARGET")!;
    const disagree = run(rbGroup({ priv: 15, mkt: 2, extra: { dispersion: 20 } })).get("TARGET")!;
    assert.ok(disagree.reason_codes.includes("MARKET_SOURCE_DISAGREEMENT"));
    assert.ok(Math.abs(disagree.actionable_edge!) <= Math.abs(agree.actionable_edge!));
  });

  it("B22a — increasing private value (market fixed) cannot reduce a positive edge", () => {
    const lo = run(rbGroup({ priv: 9, mkt: 6 })).get("TARGET")!;
    const hi = run(rbGroup({ priv: 13, mkt: 6 })).get("TARGET")!;
    assert.ok(hi.edge_score! >= lo.edge_score!);
  });

  it("B22b — increasing market value (private fixed) cannot increase a BUY edge", () => {
    const lo = run(rbGroup({ priv: 12, mkt: 4 })).get("TARGET")!;
    const hi = run(rbGroup({ priv: 12, mkt: 9 })).get("TARGET")!;
    assert.ok(hi.edge_score! <= lo.edge_score!);
  });

  it("B22c — higher confidence is at least as actionable for an identical discrepancy", () => {
    const med = run(rbGroup({ priv: 14, mkt: 3, extra: { privConf: "MEDIUM", mktCeiling: "MEDIUM" } })).get("TARGET")!;
    const high = run(rbGroup({ priv: 14, mkt: 3, extra: { privConf: "HIGH", mktCeiling: "HIGH" } })).get("TARGET")!;
    assert.equal(med.edge_score, high.edge_score);
    assert.ok(Math.abs(high.actionable_edge!) >= Math.abs(med.actionable_edge!));
  });

  it("B22d — a VERY_LOW-confidence large gap never outranks a HIGH-confidence moderate gap", () => {
    const bigLowConf = run(rbGroup({ priv: 16, mkt: 1, extra: { privConf: "VERY_LOW", mktCeiling: "VERY_LOW" } })).get("TARGET")!;
    const modHighConf = run(rbGroup({ priv: 12, mkt: 6, extra: { privConf: "HIGH", mktCeiling: "HIGH" } })).get("TARGET")!;
    assert.ok(Math.abs(modHighConf.actionable_edge!) >= Math.abs(bigLowConf.actionable_edge!));
  });

  it("B22e — missing values stay null, never coerced to 0", () => {
    const e = run(rbGroup({ priv: null as unknown as number, mkt: 5 })).get("TARGET")!;
    assert.equal(e.direction, "INSUFFICIENT_DATA");
    assert.equal(e.edge_score, null);
    assert.equal(e.private_value.normalized_value, null);
    assert.ok(e.reason_codes.includes("PRIVATE_VALUE_UNAVAILABLE"));
  });

  it("corroborating RI↔Sleeper disagreement in the same direction upgrades confidence", () => {
    const plain = run(rbGroup({ priv: 12, mkt: 6, extra: { privConf: "MEDIUM", mktCeiling: "MEDIUM" } })).get("TARGET")!;
    const corrob = run(
      rbGroup({ priv: 12, mkt: 6, extra: { privConf: "MEDIUM", mktCeiling: "MEDIUM", corr: { pct: 0.3, direction: "RI_ABOVE" } } }),
    ).get("TARGET")!;
    assert.ok(corrob.reason_codes.includes("RI_SLEEPER_DISAGREEMENT_CORROBORATES"));
    assert.ok(Math.abs(corrob.actionable_edge!) >= Math.abs(plain.actionable_edge!));
  });
});
