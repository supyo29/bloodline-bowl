/**
 * Phase 3A — calibration scenario taxonomy.
 *
 * 16 deterministic, synthetic scenarios covering the required taxonomy. Each
 * carries an `expected_direction` (never an exact target score — per the
 * Phase 3A mandate, "do not overfit to exact numeric target scores") used by
 * the ablation/calibration test suite. Roster archetypes vary (deep/thin at a
 * position, fragile/resilient, current-week-vs-ROS divergent) so the dataset
 * is not one repeated shape.
 */

import { tradeFixture, stdTeam, xfer, type StdTeamSpec } from "./trades";
import { player, proj } from "./weekly";
import type { NormalizedProposal } from "../../lib/trades/schema";
import type { CanonicalPosition } from "../../lib/canonical/schema";

export type ScenarioTaxonomy =
  | "STARTER_UPGRADE"
  | "BENCH_ONLY"
  | "DEPTH_BUILD"
  | "CONSOLIDATION"
  | "POSITIONAL_HOLE"
  | "SCARCITY_SHIFT"
  | "BYE_COVERAGE"
  | "FRAGILITY_INCREASE"
  | "FRAGILITY_DECREASE"
  | "ROS_UPGRADE"
  | "CURRENT_WEEK_UPGRADE"
  | "CURRENT_WEEK_DOWNGRADE_ROS_UPGRADE"
  | "HIGH_VARIANCE_PLAYER"
  | "ROLE_UNCERTAINTY"
  | "THREE_TEAM_BALANCED"
  | "THREE_TEAM_HIDDEN_LOSER";

export type ExpectedDirection = "POSITIVE" | "NEGATIVE" | "NEUTRAL";
export type ExpectedStrength = "MARGINAL" | "MATERIAL";

export interface CalibrationScenario {
  scenario: ScenarioTaxonomy;
  /** which participant slug the expectation applies to */
  focus_manager: string;
  expected_direction: ExpectedDirection;
  expected_strength: ExpectedStrength;
  /** which metric the expectation is about — defaults to Phase 1 roster_utility_delta */
  expected_component: "roster_utility" | "starter_points" | "ros_usable_value";
  fixture: ReturnType<typeof tradeFixture>;
}

const ROS_WEEKS = 6;
type Pos = CanonicalPosition;
const POSITIONS: Pos[] = ["QB", "RB", "WR", "TE", "K", "DEF"];
const FA = POSITIONS.flatMap((p) => [0, 1, 2, 3, 4].map((i) => player(`fa_${p}_${i}`, p)));
const FA_PROJ = POSITIONS.flatMap((p) =>
  [0, 1, 2, 3, 4].map((i) => proj(`fa_${p}_${i}`, p, p === "QB" ? 12 - i : 6 - i, { rest_of_season_points: (p === "QB" ? 12 - i : 6 - i) * ROS_WEEKS })),
);

function scene(teams: StdTeamSpec[], transfers: NormalizedProposal["transfers"]) {
  const built = teams.map(stdTeam);
  return tradeFixture({
    teams: built.map((b) => b.team),
    players: built.flatMap((b) => b.players),
    projections: built.flatMap((b) => b.projections),
    freeAgents: FA, faProjections: FA_PROJ, transfers,
    rosFlatHorizon: ROS_WEEKS,
  });
}
const T = (slug: string, over: Partial<StdTeamSpec> = {}): StdTeamSpec => ({ slug, flex: { id: `${slug}_flex`, pos: "WR", pts: 10 }, ...over });

export function buildCalibrationScenarios(): CalibrationScenario[] {
  const scenarios: CalibrationScenario[] = [];

  // 1. STARTER_UPGRADE — a clean upgrade at a starting slot
  scenarios.push({
    scenario: "STARTER_UPGRADE", focus_manager: "X", expected_direction: "POSITIVE", expected_strength: "MATERIAL", expected_component: "roster_utility",
    fixture: scene(
      [T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 } }), T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "IN", pos: "WR", pts: 18 }] })],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")],
    ),
  });

  // 2. BENCH_ONLY — acquisition never cracks the lineup
  scenarios.push({
    scenario: "BENCH_ONLY", focus_manager: "X", expected_direction: "NEUTRAL", expected_strength: "MARGINAL", expected_component: "starter_points",
    fixture: scene(
      [T("X", { flex: { id: "X_flex", pos: "WR", pts: 16 } }), T("Y", { bench: [{ id: "IN", pos: "WR", pts: 9 }] })],
      [xfer("Y", "X", "IN")],
    ),
  });

  // 3. DEPTH_BUILD — 1 starter -> 3 useful depth pieces (receiving side gains depth, loses a starter)
  scenarios.push({
    scenario: "DEPTH_BUILD", focus_manager: "Y", expected_direction: "POSITIVE", expected_strength: "MARGINAL", expected_component: "roster_utility",
    fixture: scene(
      [T("X", { flex: { id: "X_ELITE", pos: "WR", pts: 22 } }), T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "j1", pos: "WR", pts: 6 }, { id: "j2", pos: "WR", pts: 6 }, { id: "j3", pos: "RB", pts: 6 }] })],
      [xfer("Y", "X", "j1"), xfer("Y", "X", "j2"), xfer("Y", "X", "j3"), xfer("X", "Y", "X_ELITE")],
    ),
  });

  // 4. CONSOLIDATION — 3 depth -> 1 starter (the shipping side)
  scenarios.push({
    scenario: "CONSOLIDATION", focus_manager: "X", expected_direction: "POSITIVE", expected_strength: "MATERIAL", expected_component: "roster_utility",
    fixture: scene(
      [T("X", { bench: [{ id: "d1", pos: "WR", pts: 9 }, { id: "d2", pos: "WR", pts: 9 }, { id: "d3", pos: "RB", pts: 9 }] }), T("Y", { bench: [{ id: "STAR", pos: "WR", pts: 24 }] })],
      [xfer("X", "Y", "d1"), xfer("X", "Y", "d2"), xfer("X", "Y", "d3"), xfer("Y", "X", "STAR")],
    ),
  });

  // 5. POSITIONAL_HOLE — fills a genuinely unfillable/critical slot
  scenarios.push({
    scenario: "POSITIONAL_HOLE", focus_manager: "X", expected_direction: "POSITIVE", expected_strength: "MATERIAL", expected_component: "roster_utility",
    fixture: scene(
      [T("X", { flex: { id: "X_wrflex", pos: "WR", pts: 11 }, bench: [{ id: "X_dep", pos: "WR", pts: 7 }], lockPts: { RB1: 15, RB2: 2 } }),
       T("Y", { bench: [{ id: "IN_rb", pos: "RB", pts: 17 }] })],
      [xfer("X", "Y", "X_dep"), xfer("Y", "X", "IN_rb")],
    ),
  });

  // 6. SCARCITY_SHIFT — same player, scarce-position roster vs deep roster (receiving side is the scarce one)
  scenarios.push({
    scenario: "SCARCITY_SHIFT", focus_manager: "X", expected_direction: "POSITIVE", expected_strength: "MATERIAL", expected_component: "roster_utility",
    fixture: scene(
      [T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 }, lockPts: { WR2: 5 } }), T("Y", { bench: [{ id: "IN", pos: "WR", pts: 15 }] })],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")],
    ),
  });

  // 7. BYE_COVERAGE — acquired player solves a bye hole
  scenarios.push({
    scenario: "BYE_COVERAGE", focus_manager: "X", expected_direction: "POSITIVE", expected_strength: "MARGINAL", expected_component: "roster_utility",
    fixture: scene(
      [T("X", { flex: { id: "X_flex", pos: "WR", pts: 9 }, bench: [{ id: "X_junk", pos: "WR", pts: 3 }] }), T("Y", { bench: [{ id: "COVER", pos: "TE", pts: 9 }] })],
      [xfer("X", "Y", "X_junk"), xfer("Y", "X", "COVER")],
    ),
  });

  // 8. FRAGILITY_INCREASE — ship the only usable backup at a position
  scenarios.push({
    scenario: "FRAGILITY_INCREASE", focus_manager: "X", expected_direction: "NEGATIVE", expected_strength: "MARGINAL", expected_component: "roster_utility",
    fixture: scene(
      [T("X", { bench: [{ id: "RB3", pos: "RB", pts: 14 }] }), T("Y", { bench: [{ id: "sp", pos: "WR", pts: 2 }] })],
      [xfer("X", "Y", "RB3"), xfer("Y", "X", "sp")],
    ),
  });

  // 9. FRAGILITY_DECREASE — acquire a usable backup
  scenarios.push({
    scenario: "FRAGILITY_DECREASE", focus_manager: "X", expected_direction: "POSITIVE", expected_strength: "MARGINAL", expected_component: "roster_utility",
    fixture: scene(
      [T("X", { bench: [{ id: "junk", pos: "K", pts: 1 }], lockPts: { RB2: 6 } }), T("Y", { bench: [{ id: "RB_COVER", pos: "RB", pts: 13 }] })],
      [xfer("X", "Y", "junk"), xfer("Y", "X", "RB_COVER")],
    ),
  });

  // 10. ROS_UPGRADE — pure rest-of-season improvement, current week ~flat
  scenarios.push({
    scenario: "ROS_UPGRADE", focus_manager: "X", expected_direction: "POSITIVE", expected_strength: "MATERIAL", expected_component: "roster_utility",
    fixture: scene(
      [T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 }, lockPts: { WR2: 6 } }), T("Y", { bench: [{ id: "IN", pos: "WR", pts: 15 }] })],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")],
    ),
  });

  // 11. CURRENT_WEEK_UPGRADE — hot-now player, ROS roughly flat
  scenarios.push({
    scenario: "CURRENT_WEEK_UPGRADE", focus_manager: "X", expected_direction: "POSITIVE", expected_strength: "MATERIAL", expected_component: "roster_utility",
    fixture: scene(
      [T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 } }), T("Y", { bench: [{ id: "HOTNOW", pos: "WR", pts: 18 }] })],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "HOTNOW")],
    ),
  });

  // 12. CURRENT_WEEK_DOWNGRADE_ROS_UPGRADE — cool now, hot ROS
  {
    const f = scene(
      [T("X", { flex: { id: "HOTNOW", pos: "WR", pts: 18 } }), T("Y", { bench: [{ id: "HOTROS", pos: "WR", pts: 9 }] })],
      [xfer("X", "Y", "HOTNOW"), xfer("Y", "X", "HOTROS")],
    );
    const set = (id: string, weekly: number, rosMean: number) => {
      const cur = f.input.projections.by_player.get(id)!;
      const ros = Math.round(rosMean * ROS_WEEKS);
      f.input.projections.by_player.set(id, { ...cur, projected_points: weekly, rest_of_season_points: ros, ros: cur.ros ? { ...cur.ros, points: ros } : cur.ros });
    };
    set("HOTNOW", 18, 7);
    set("HOTROS", 9, 17);
    // The label's own point is a Phase1/Phase2 DIVERGENCE: current-week utility
    // drops while ROS usable value rises — checked against ros_usable_value.
    scenarios.push({ scenario: "CURRENT_WEEK_DOWNGRADE_ROS_UPGRADE", focus_manager: "X", expected_direction: "POSITIVE", expected_strength: "MARGINAL", expected_component: "ros_usable_value", fixture: f });
  }

  // 13. HIGH_VARIANCE_PLAYER — large std_dev relative to projection
  {
    const f = scene(
      [T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 } }), T("Y", { bench: [{ id: "VOLATILE", pos: "WR", pts: 14 } ] })],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "VOLATILE")],
    );
    const cur = f.input.projections.by_player.get("VOLATILE")!;
    f.input.projections.by_player.set("VOLATILE", { ...cur, std_dev: cur.projected_points! * 0.9 });
    scenarios.push({ scenario: "HIGH_VARIANCE_PLAYER", focus_manager: "X", expected_direction: "POSITIVE", expected_strength: "MARGINAL", expected_component: "roster_utility", fixture: f });
  }

  // 14. ROLE_UNCERTAINTY — RI/external ROS disagreement is large
  {
    const f = scene(
      [T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 } }), T("Y", { bench: [{ id: "UNCERTAIN", pos: "WR", pts: 13 }] })],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "UNCERTAIN")],
    );
    const cur = f.input.projections.by_player.get("UNCERTAIN")!;
    f.input.projections.by_player.set("UNCERTAIN", { ...cur, ros: cur.ros ? { ...cur.ros, disagreement_pct: 0.55, disagreement_direction: "RI_BELOW" } : cur.ros });
    scenarios.push({ scenario: "ROLE_UNCERTAINTY", focus_manager: "X", expected_direction: "POSITIVE", expected_strength: "MARGINAL", expected_component: "roster_utility", fixture: f });
  }

  // 15. THREE_TEAM_BALANCED — complementary needs, all three improve
  scenarios.push({
    scenario: "THREE_TEAM_BALANCED", focus_manager: "A", expected_direction: "POSITIVE", expected_strength: "MATERIAL", expected_component: "roster_utility",
    fixture: scene(
      [T("A", { flex: { id: "A_flex", pos: "RB", pts: 16 }, bench: [{ id: "A_rb4", pos: "RB", pts: 14 }], lockPts: { WR2: 6 } }),
       T("B", { flex: { id: "B_flex", pos: "WR", pts: 16 }, bench: [{ id: "B_wr4", pos: "WR", pts: 14 }], lockPts: { TE: 5 } }),
       T("C", { flex: { id: "C_flex", pos: "WR", pts: 14 }, bench: [{ id: "C_te2", pos: "TE", pts: 13 }], lockPts: { RB2: 6, TE: 13 } })],
      [xfer("A", "C", "A_rb4"), xfer("C", "B", "C_te2"), xfer("B", "A", "B_wr4")],
    ),
  });

  // 16. THREE_TEAM_HIDDEN_LOSER — Phase 1 likes all three, C materially loses
  scenarios.push({
    scenario: "THREE_TEAM_HIDDEN_LOSER", focus_manager: "C", expected_direction: "NEGATIVE", expected_strength: "MATERIAL", expected_component: "roster_utility",
    fixture: scene(
      [T("A", { flex: { id: "A_flex", pos: "RB", pts: 16 }, bench: [{ id: "A_rb4", pos: "RB", pts: 8 }], lockPts: { WR2: 6 } }),
       T("B", { flex: { id: "B_flex", pos: "WR", pts: 16 }, bench: [{ id: "B_wr4", pos: "WR", pts: 14 }], lockPts: { TE: 6 } }),
       T("C", { flex: { id: "C_flex", pos: "WR", pts: 14 }, bench: [{ id: "C_te2", pos: "TE", pts: 18 }], lockPts: { RB2: 6, TE: 13 } })],
      [xfer("A", "C", "A_rb4"), xfer("C", "B", "C_te2"), xfer("B", "A", "B_wr4")],
    ),
  });

  return scenarios;
}
