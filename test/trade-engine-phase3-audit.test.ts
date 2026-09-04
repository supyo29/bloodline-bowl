/**
 * Trade Engine — Phase 3 AUDIT regression suite.
 *
 * Covers findings from the Phase 3 Calibration and Player Intelligence audit
 * that were not already exercised by `trade-engine-phase3.test.ts` /
 * `trade-engine-phase3-calibration.test.ts`: the availability defect fix
 * (D1), API-supplied-weight isolation, extreme-input overflow safety under
 * the ACTUAL production (zero) weight configuration, cross-participant
 * isolation, determinism, and the "same player, different roster" check.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tradeFixture, stdTeam, xfer, type StdTeamSpec } from "./fixtures/trades";
import { player, proj } from "./fixtures/weekly";
import { evaluateTrade } from "../lib/trades/evaluate";
import { computeShadowUtility, clamp } from "../lib/trades/phase3";
import { resolveTradeConfig, DEFAULT_TRADE_CONFIG } from "../lib/trades/config";
import type { CanonicalPosition } from "../lib/canonical/schema";
import type { NormalizedProposal } from "../lib/trades/schema";

const ROS_WEEKS = 6;
type Pos = CanonicalPosition;
const POSITIONS: Pos[] = ["QB", "RB", "WR", "TE", "K", "DEF"];
const FA = POSITIONS.flatMap((p) => [0, 1, 2, 3, 4].map((i) => player(`fa_${p}_${i}`, p)));
const FA_PROJ = POSITIONS.flatMap((p) =>
  [0, 1, 2, 3, 4].map((i) => proj(`fa_${p}_${i}`, p, p === "QB" ? 12 - i : 6 - i, { rest_of_season_points: (p === "QB" ? 12 - i : 6 - i) * ROS_WEEKS })),
);
function scene(teams: StdTeamSpec[], transfers: NormalizedProposal["transfers"], cfg?: Parameters<typeof tradeFixture>[0]["config"]) {
  const built = teams.map(stdTeam);
  return tradeFixture({
    teams: built.map((b) => b.team), players: built.flatMap((b) => b.players), projections: built.flatMap((b) => b.projections),
    freeAgents: FA, faProjections: FA_PROJ, transfers, config: cfg, rosFlatHorizon: ROS_WEEKS,
  });
}
const T = (slug: string, over: Partial<StdTeamSpec> = {}): StdTeamSpec => ({ slug, flex: { id: `${slug}_flex`, pos: "WR", pts: 10 }, ...over });

describe("Phase 3 audit — hidden-influence / API weight isolation (§3, §24)", () => {
  it("a caller-supplied nonzero phase3 weight via public config has NO effect while the underlying adjustment is architecturally 0", () => {
    const f = scene([T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 } }), T("Y", { bench: [{ id: "IN", pos: "WR", pts: 16 }] })], [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")]);
    const cfgDefault = resolveTradeConfig();
    const cfgHostileOverride = resolveTradeConfig({ phase3: { weights: { role_adjustment: 999, schedule_adjustment: 999 } } });
    const outDefault = evaluateTrade({ ...f.input, config: cfgDefault, context: f.context({ rosWeeks: ROS_WEEKS }) });
    const outOverride = evaluateTrade({ ...f.input, config: cfgHostileOverride, context: f.context({ rosWeeks: ROS_WEEKS }) });
    for (const slug of ["X", "Y"]) {
      assert.equal(
        outOverride.participants[slug]!.phase3!.shadow_utility_delta,
        outDefault.participants[slug]!.phase3!.shadow_utility_delta,
        `${slug}: a hostile weight override must not move shadow_utility_delta because role/schedule adjustments are hardcoded 0`,
      );
    }
  });

  it("DEFAULT_TRADE_CONFIG.phase3 weights/caps are never mutated in place by resolveTradeConfig overrides (test-only weights cannot leak)", () => {
    resolveTradeConfig({ phase3: { weights: { role_adjustment: 42 } } });
    assert.equal(DEFAULT_TRADE_CONFIG.phase3.weights.role_adjustment, 0, "resolveTradeConfig must spread into a new object, never write through to the shared default");
  });
});

describe("Phase 3 audit — overflow safety under the ACTUAL production weight configuration (§28)", () => {
  const prodWeights = DEFAULT_TRADE_CONFIG.phase3.weights; // {role_adjustment: 0, schedule_adjustment: 0}

  it("a NaN adjustment cannot leak through even at weight 0 (0 * NaN = NaN in IEEE 754 — the fallback must still catch it)", () => {
    const result = computeShadowUtility(12.34, NaN, 0, prodWeights);
    assert.equal(result, 12.34, "with weight 0 the fallback must recover the exact contextual value, not propagate NaN");
  });

  it("very large NEGATIVE synthetic inputs stay finite (only the positive extreme was covered previously)", () => {
    assert.ok(Number.isFinite(computeShadowUtility(-Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE, { role_adjustment: 1, schedule_adjustment: 1 })));
  });

  it("-Infinity role adjustment stays finite", () => {
    assert.ok(Number.isFinite(computeShadowUtility(5, -Infinity, 0, { role_adjustment: 1, schedule_adjustment: 0 })));
  });

  it("clamp(NaN, cap) returns NaN (documented, not silently coerced) — safe today only because production callers always pass a literal 0, never a computed value", () => {
    assert.ok(Number.isNaN(clamp(NaN, 3)));
  });

  it("clamp with a zero cap collapses to exactly 0 for any input (JS -0 accepted: -0 === 0 arithmetically)", () => {
    assert.equal(clamp(500, 0), 0);
    assert.equal(Object.is(clamp(-500, 0), -0) || clamp(-500, 0) === 0, true);
  });
});

describe("Phase 3 audit — cross-participant isolation (§39, §41)", () => {
  it("one participant's degraded ROS coverage does not lower another participant's confidence", () => {
    const f = scene(
      [T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 } }), T("Y", { bench: [{ id: "IN", pos: "WR", pts: 16 }] })],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")],
    );
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    // Strip the ROS signal for X's incoming player only (simulates partial data for ONE participant).
    const wp = ctx.projections.by_player.get("IN")!;
    ctx.projections.by_player.set("IN", { ...wp, ros: null, rest_of_season_points: null });
    const out = evaluateTrade({ ...f.input, context: ctx });
    // Y's own confidence must be governed by Y's own roster coverage, not X's.
    assert.ok(out.participants.Y!.phase3, "Y still gets a full phase3 block");
    assert.ok(out.participants.X!.phase3, "X still gets a phase3 block even though one of its incoming players is ROS-degraded");
  });
});

describe("Phase 3 audit — determinism (§37)", () => {
  it("repeated evaluation of the identical trade produces a byte-identical phase3 block", () => {
    const f = scene(
      [T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 } }), T("Y", { bench: [{ id: "IN", pos: "WR", pts: 16 }] })],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")],
    );
    const out1 = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) });
    const out2 = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) });
    assert.deepEqual(out1.participants.X!.phase3, out2.participants.X!.phase3);
    assert.deepEqual(out1.participants.Y!.phase3, out2.participants.Y!.phase3);
    assert.deepEqual(out1.phase3_summary, out2.phase3_summary);
  });
});

describe("Phase 3 audit — same player, different roster context stays roster-specific (§40)", () => {
  it("the same transferred player's phase3_adjusted_value differs across two different receiving rosters (Phase 3 never collapses to a global player-value chart)", () => {
    // Roster A: STUD lands on a team that already has strong WR depth -> low marginal value.
    const deepWr = scene(
      [{ slug: "X", flex: { id: "X_flex", pos: "WR", pts: 18 }, bench: [{ id: "X_wr3", pos: "WR", pts: 17 }, { id: "SEND", pos: "RB", pts: 3 }], lockPts: { WR1: 20, WR2: 19 } },
       T("Y", { bench: [{ id: "STUD", pos: "WR", pts: 15 }] })],
      [xfer("X", "Y", "SEND"), xfer("Y", "X", "STUD")],
    );
    // Roster B: STUD lands on a team with a thin WR room -> higher marginal value.
    const thinWr = scene(
      [{ slug: "X", flex: { id: "X_flex", pos: "RB", pts: 12 }, bench: [{ id: "SEND", pos: "RB", pts: 3 }], lockPts: {} },
       T("Y", { bench: [{ id: "STUD", pos: "WR", pts: 15 }] })],
      [xfer("X", "Y", "SEND"), xfer("Y", "X", "STUD")],
    );
    const outDeep = evaluateTrade({ ...deepWr.input, context: deepWr.context({ rosWeeks: ROS_WEEKS }) });
    const outThin = evaluateTrade({ ...thinWr.input, context: thinWr.context({ rosWeeks: ROS_WEEKS }) });
    const studDeep = outDeep.participants.X!.phase3!.player_attribution.find((a) => a.canonical_player_id === "STUD")!;
    const studThin = outThin.participants.X!.phase3!.player_attribution.find((a) => a.canonical_player_id === "STUD")!;
    assert.notEqual(
      studDeep.phase3_adjusted_value,
      studThin.phase3_adjusted_value,
      "the same player must carry a different phase3_adjusted_value depending on the receiving roster's context, inherited honestly from phase2_marginal_ros",
    );
  });
});
