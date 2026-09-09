/**
 * Competitive Trade Intelligence — pre-merge certification fix, Part B:
 * trade classification vs TRANSACTION READINESS.
 *
 * "This trade looks analytically attractive" is not the same statement as
 * "you should execute this trade now". The competitive classification answers
 * the first question; `transactionReadiness()` answers the second, consistently
 * across evaluate / negotiate / discover / strategy-path.
 *
 * Deterministic. Covers spec Part B §14–§34.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { transactionReadiness, describeTransactionReadiness } from "../lib/trades/competitive/schema";
import type { TransactionReadinessInput } from "../lib/trades/competitive/schema";

const inp = (o: Partial<TransactionReadinessInput>): TransactionReadinessInput => ({
  classification: "COMPETITIVE_BUY",
  competitively_actionable: true,
  confidence: "MEDIUM",
  acceptance: "MODERATE",
  permanent_trade_utility: 2,
  horizon_review_required: false,
  ...o,
});

describe("Competitive Trade — transaction readiness taxonomy (Part B)", () => {
  it("§28 positive control — strong gain + sufficient confidence + sufficient acceptance ⇒ TRANSACTION_READY", () => {
    assert.equal(
      transactionReadiness(inp({ classification: "STRONG_COMPETITIVE_BUY", confidence: "HIGH", acceptance: "HIGH", permanent_trade_utility: 5 })),
      "TRANSACTION_READY",
    );
    assert.equal(transactionReadiness(inp({ confidence: "MEDIUM", acceptance: "MODERATE" })), "TRANSACTION_READY");
  });

  it("§29 low-confidence positive ⇒ NEGOTIATION_WORTH_EXPLORING, not transaction-ready", () => {
    const r = transactionReadiness(inp({ classification: "COMPETITIVE_BUY", confidence: "LOW", acceptance: "LOW", permanent_trade_utility: 2 }));
    assert.ok(r === "NEGOTIATION_WORTH_EXPLORING" || r === "EXPLORATORY");
    assert.notEqual(r, "TRANSACTION_READY");
  });

  it("§22 LOW confidence can NEVER be TRANSACTION_READY, whatever the acceptance", () => {
    for (const acc of ["LOW", "MODERATE", "HIGH"] as const) {
      assert.notEqual(transactionReadiness(inp({ confidence: "LOW", acceptance: acc })), "TRANSACTION_READY");
      assert.notEqual(transactionReadiness(inp({ confidence: "VERY_LOW", acceptance: acc })), "TRANSACTION_READY");
    }
  });

  it("§23/§32 strong private gain + HIGH confidence but LOW acceptance ⇒ NEGOTIATION_WORTH_EXPLORING (a lead, not executable)", () => {
    const r = transactionReadiness(inp({ classification: "STRONG_COMPETITIVE_BUY", confidence: "HIGH", acceptance: "LOW", permanent_trade_utility: 6 }));
    assert.equal(r, "NEGOTIATION_WORTH_EXPLORING");
  });

  it("§23 acceptance VERY_LOW ⇒ NOT_RECOMMENDED (acceptance is a feasibility constraint, not a reward)", () => {
    assert.equal(transactionReadiness(inp({ acceptance: "VERY_LOW" })), "NOT_RECOMMENDED");
  });

  it("§31 REVIEW_REQUIRED horizon ⇒ REVIEW_REQUIRED, never exploratory/ready", () => {
    assert.equal(
      transactionReadiness(inp({ classification: "COMPETITIVE_BUY", confidence: "HIGH", acceptance: "HIGH", horizon_review_required: true, permanent_trade_utility: 4 })),
      "REVIEW_REQUIRED",
    );
  });

  it("negative permanent gain ⇒ NOT_RECOMMENDED regardless of classification", () => {
    assert.equal(transactionReadiness(inp({ classification: "STRONG_COMPETITIVE_BUY", confidence: "HIGH", acceptance: "HIGH", permanent_trade_utility: -1 })), "NOT_RECOMMENDED");
  });

  it("REJECT / AVOID_COMPETITIVE_COST ⇒ NOT_RECOMMENDED", () => {
    assert.equal(transactionReadiness(inp({ classification: "REJECT" })), "NOT_RECOMMENDED");
    assert.equal(transactionReadiness(inp({ classification: "AVOID_COMPETITIVE_COST" })), "NOT_RECOMMENDED");
  });

  it("MARGINAL classification with thin evidence ⇒ EXPLORATORY", () => {
    assert.equal(
      transactionReadiness(inp({ classification: "MARGINAL", competitively_actionable: false, confidence: "VERY_LOW", acceptance: "LOW", permanent_trade_utility: 0.5 })),
      "EXPLORATORY",
    );
  });

  it("§34 wording — describeTransactionReadiness never calls a non-ready state 'certified' or 'ready'", () => {
    for (const r of ["EXPLORATORY", "NEGOTIATION_WORTH_EXPLORING", "REVIEW_REQUIRED", "NOT_RECOMMENDED"] as const) {
      const text = describeTransactionReadiness(r).toLowerCase();
      assert.ok(!text.includes("certified"));
      assert.ok(!/\bready\b/.test(text), `"${text}" should not call a non-ready state ready`);
    }
    assert.ok(describeTransactionReadiness("TRANSACTION_READY").toLowerCase().includes("now"));
  });

  it("§30 no-action reconciliation — a positive-but-low-confidence trade is a lead, and NO_ACTION can coexist with it", () => {
    // simulate the discovery scenario: several positive candidates, none transaction-ready
    const candidates = [
      inp({ confidence: "LOW", acceptance: "LOW", permanent_trade_utility: 2.5 }),
      inp({ confidence: "LOW", acceptance: "MODERATE", permanent_trade_utility: 1.8 }),
      inp({ classification: "STRONG_COMPETITIVE_BUY", confidence: "LOW", acceptance: "LOW", permanent_trade_utility: 3.0 }),
    ].map(transactionReadiness);
    assert.ok(candidates.every((r) => r !== "TRANSACTION_READY"));
    assert.ok(candidates.some((r) => r === "NEGOTIATION_WORTH_EXPLORING" || r === "EXPLORATORY"));
    // → an engine that finds these should still recommend NO_ACTION, with the
    //   candidates surfaced as leads. No contradiction.
  });
});
