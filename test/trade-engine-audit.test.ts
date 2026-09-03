/**
 * Trade Engine — Phase 1 AUDIT suite.
 *
 * Adversarial verification of the freeze-gate invariant:
 *   "A fantasy asset is valued according to the marginal effect its transfer has
 *    on the sending and receiving rosters, with every affected roster
 *    independently rebuilt and re-optimized after the transaction."
 *
 * Every team is built with `stdTeam` — per-team-unique locked starters, so the
 * same player is never on two rosters and replacement levels are well-defined.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  tradeFixture,
  stdTeam,
  validateTrade,
  xfer,
  MID,
  type StdTeamSpec,
  type TradeFixtureSpec,
} from "./fixtures/trades";
import { player, proj, STD_CONSTRAINTS } from "./fixtures/weekly";
import { evaluateTrade } from "../lib/trades/evaluate";
import { analyzeTrade } from "../lib/trades/analyze";
import { TRADE_ENGINE_VERSION } from "../lib/trades/schema";
import { reconstructRosters } from "../lib/trades/reconstruct";
import { classifyAcceptance, resolveTradeConfig, DEFAULT_TRADE_CONFIG } from "../lib/trades/config";
import type { NormalizedProposal } from "../lib/trades/schema";

/* ----------------------------------------------------------------- universe */

// deep FA pool -> stable replacement levels
const FA = ["QB", "RB", "WR", "TE", "K", "DEF"].flatMap((pos) =>
  [0, 1, 2, 3, 4].map((i) => player(`fa_${pos}_${i}`, pos as never)),
);
const FA_PROJ = ["QB", "RB", "WR", "TE", "K", "DEF"].flatMap((pos) =>
  [0, 1, 2, 3, 4].map((i) => proj(`fa_${pos}_${i}`, pos, pos === "QB" ? 12 - i : 6 - i)),
);

function scene(
  teams: StdTeamSpec[],
  transfers: NormalizedProposal["transfers"],
  opts: Partial<Omit<TradeFixtureSpec, "teams" | "players" | "projections" | "transfers">> = {},
) {
  const built = teams.map(stdTeam);
  return tradeFixture({
    teams: built.map((b) => b.team),
    players: built.flatMap((b) => b.players),
    projections: built.flatMap((b) => b.projections),
    freeAgents: FA,
    faProjections: FA_PROJ,
    transfers,
    ...opts,
  });
}

const GENERIC = (slug: string, flexPts = 9): StdTeamSpec => ({ slug, flex: { id: `${slug}_flex`, pos: "WR", pts: flexPts } });

/* ===================================================================== */
/* §2 — N-PARTY routing, no bilateral reciprocity                         */
/* ===================================================================== */

describe("audit §2 — N-party routing", () => {
  const teams: StdTeamSpec[] = [
    { slug: "A", flex: { id: "A_flex", pos: "RB", pts: 11 }, bench: [{ id: "A_extra", pos: "WR", pts: 7 }] },
    { slug: "B", flex: { id: "B_flex", pos: "WR", pts: 12 }, bench: [{ id: "B_extra", pos: "RB", pts: 8 }] },
    { slug: "C", flex: { id: "C_flex", pos: "TE", pts: 10 }, bench: [{ id: "C_extra", pos: "WR", pts: 6 }] },
  ];

  it("circular A→B→C→A with NO bilateral pair is fully evaluated", () => {
    const f = scene(teams, [xfer("A", "B", "A_flex"), xfer("B", "C", "B_flex"), xfer("C", "A", "C_flex")]);
    const out = evaluateTrade(f.input);
    assert.deepEqual(Object.keys(out.participants).sort(), ["A", "B", "C"]);
    assert.deepEqual(out.participants.A!.after.incoming_player_ids, ["C_flex"]);
    assert.deepEqual(out.participants.A!.after.outgoing_player_ids, ["A_flex"]);
    assert.deepEqual(out.participants.C!.after.incoming_player_ids, ["B_flex"]);
    for (const p of Object.values(out.participants)) {
      assert.equal(p.before.optimal_starters.length, 9);
      assert.equal(p.after.optimal_starters.length, 9);
    }
  });

  it("non-circular routing A→B, A→C, B→A, C→B (unequal in/out counts)", () => {
    const f = scene(teams, [xfer("A", "B", "A_flex"), xfer("A", "C", "A_extra"), xfer("B", "A", "B_flex"), xfer("C", "B", "C_extra")]);
    const out = evaluateTrade(f.input);
    assert.deepEqual(out.participants.A!.after.outgoing_player_ids.slice().sort(), ["A_extra", "A_flex"]);
    assert.deepEqual(out.participants.A!.after.incoming_player_ids, ["B_flex"]);
    assert.deepEqual(out.participants.B!.after.incoming_player_ids.slice().sort(), ["A_flex", "C_extra"]);
    assert.deepEqual(out.participants.C!.after.incoming_player_ids, ["A_extra"]);
    assert.equal(out.participants.A!.after.roster_size, 9);
  });

  it("one manager receives multiple assets", () => {
    const f = scene(teams, [xfer("A", "B", "A_flex"), xfer("C", "B", "C_flex"), xfer("B", "A", "B_flex"), xfer("B", "C", "B_extra")]);
    const out = evaluateTrade(f.input);
    assert.deepEqual(out.participants.B!.after.incoming_player_ids.slice().sort(), ["A_flex", "C_flex"]);
    assert.deepEqual(out.participants.B!.after.outgoing_player_ids.slice().sort(), ["B_extra", "B_flex"]);
  });
});

/* ===================================================================== */
/* §3/§4 — ATOMICITY & duplicate-asset laundering                         */
/* ===================================================================== */

describe("audit §3/§4 — atomicity & duplicate-asset laundering", () => {
  const teams: StdTeamSpec[] = [
    { slug: "A", flex: { id: "A_flex", pos: "RB", pts: 9 }, bench: [{ id: "A_X", pos: "RB", pts: 10 }] },
    GENERIC("B"),
    GENERIC("C"),
  ];

  it("A→B:A_X then B→C:A_X is REJECTED (a player cannot move twice)", () => {
    const f = scene(teams, []);
    const r = validateTrade(f.resolution(
      [{ input: "A", slug: "A" }, { input: "B", slug: "B" }, { input: "C", slug: "C" }],
      [{ from: "A", to: "B", pid: "A_X", cid: "A_X" }, { from: "B", to: "C", pid: "A_X", cid: "A_X" }],
    ));
    assert.equal(r.result.ok, false);
    assert.ok(r.result.failures.some((x) => x.code === "DUPLICATE_TRANSFER"));
    assert.ok(r.result.failures.some((x) => x.code === "PLAYER_NOT_OWNED_BY_SENDER"),
      "B never owned A_X pre-trade");
  });

  it("reconstruction applies ALL transfers against the ORIGINAL state, not chained", () => {
    const f = scene(teams, []);
    const normalized: NormalizedProposal = {
      league_slug: "test-league",
      participant_manager_ids: [MID("A"), MID("B"), MID("C")],
      transfers: [xfer("A", "B", "A_flex"), xfer("B", "C", "B_flex")],
    };
    const recon = reconstructRosters(normalized, f.rosters);
    const b = recon.by_manager.get(MID("B"))!;
    assert.ok(b.after.all_players.includes("A_flex"));
    assert.ok(!b.after.all_players.includes("B_flex"));
    assert.ok(b.before.all_players.includes("B_flex"));
    const all = ["A", "B", "C"].flatMap((s) => recon.by_manager.get(MID(s))!.after.all_players);
    assert.equal(all.length, new Set(all).size, "no player on two post-trade rosters");
    // B lost exactly one and gained exactly one -> size unchanged
    assert.equal(b.after.all_players.length, b.before.all_players.length);
  });
});

/* ===================================================================== */
/* §4 — VALIDATION failure codes                                          */
/* ===================================================================== */

describe("audit §4 — validation failure codes", () => {
  const f = scene([GENERIC("A"), GENERIC("B")], []);
  const P2 = [{ input: "A", slug: "A" as string | null }, { input: "B", slug: "B" as string | null }];
  const R = (parts: typeof P2, transfers: Array<{ from: string; to: string; pid: string; cid: string | null }>) => f.resolution(parts, transfers);

  const cases: Array<[string, ReturnType<typeof R>, string]> = [
    ["unknown participant", R([P2[0]!, { input: "ghost", slug: null }], [{ from: "A", to: "ghost", pid: "A_flex", cid: "A_flex" }]), "UNKNOWN_MANAGER"],
    ["unknown player", R(P2, [{ from: "A", to: "B", pid: "??", cid: null }]), "UNKNOWN_PLAYER"],
    ["player not owned by sender", R(P2, [{ from: "A", to: "B", pid: "B_flex", cid: "B_flex" }]), "PLAYER_NOT_OWNED_BY_SENDER"],
    ["self-transfer", R(P2, [{ from: "A", to: "A", pid: "A_flex", cid: "A_flex" }]), "SELF_TRANSFER"],
    ["recipient outside participant set", R(P2, [{ from: "A", to: "Z", pid: "A_flex", cid: "A_flex" }]), "INVALID_PARTICIPANT"],
    ["duplicate participant", R([P2[0]!, P2[0]!], [{ from: "A", to: "A", pid: "A_flex", cid: "A_flex" }]), "DUPLICATE_PARTICIPANT"],
    ["too few participants", R([P2[0]!], [{ from: "A", to: "A", pid: "A_flex", cid: "A_flex" }]), "TOO_FEW_PARTICIPANTS"],
    ["no transfers", R(P2, []), "NO_TRANSFERS"],
    ["duplicate transfer", R(P2, [{ from: "A", to: "B", pid: "A_flex", cid: "A_flex" }, { from: "A", to: "B", pid: "A_flex", cid: "A_flex" }]), "DUPLICATE_TRANSFER"],
  ];
  for (const [name, res, code] of cases) {
    it(`rejects: ${name} -> ${code}`, () => {
      const r = validateTrade(res);
      assert.equal(r.result.ok, false, name);
      assert.ok(r.result.failures.some((x) => x.code === code), `${name}: expected ${code}, got ${r.result.failures.map((x) => x.code)}`);
    });
  }

  it("post-trade roster that cannot field a legal lineup is rejected", () => {
    // A trades away its only QB.
    const r = validateTrade(R(P2, [{ from: "A", to: "B", pid: "A_QB", cid: "A_QB" }]));
    assert.ok(r.result.failures.some((x) => x.code === "POST_TRADE_ROSTER_ILLEGAL"), JSON.stringify(r.result.failures));
  });

  it("post-trade roster over the league size limit is rejected (drop not included)", () => {
    const tiny = scene(
      [
        { slug: "A", flex: { id: "A_flex", pos: "WR", pts: 9 } },
        { slug: "B", flex: { id: "B_flex", pos: "WR", pts: 9 }, bench: [{ id: "B_x", pos: "RB", pts: 5 }] },
      ],
      [],
      { constraints: { ...STD_CONSTRAINTS, roster_size_limit: 9 } },
    );
    const r = validateTrade(tiny.resolution(P2, [
      { from: "B", to: "A", pid: "B_x", cid: "B_x" },
      { from: "B", to: "A", pid: "B_flex", cid: "B_flex" },
      { from: "A", to: "B", pid: "A_flex", cid: "A_flex" },
    ]));
    assert.ok(r.result.failures.some((x) => x.code === "POST_TRADE_ROSTER_OVER_SIZE_LIMIT"), JSON.stringify(r.result.failures));
  });

  it("a clean trade passes and returns a canonical normalized proposal", () => {
    const r = validateTrade(R(P2, [
      { from: "A", to: "B", pid: "A_flex", cid: "A_flex" },
      { from: "B", to: "A", pid: "B_flex", cid: "B_flex" },
    ]));
    assert.equal(r.result.ok, true, JSON.stringify(r.result.failures));
    assert.ok(r.normalized!.transfers.every((t) => t.from_manager_id.startsWith("manager:")));
  });

  it("a self-transfer disguised by two aliases resolving to the same manager is rejected", () => {
    const r = validateTrade(f.resolution(
      [{ input: "A", slug: "A" }, { input: "Aalias", slug: "A" }, { input: "B", slug: "B" }],
      [{ from: "A", to: "Aalias", pid: "A_flex", cid: "A_flex" }],
    ));
    assert.equal(r.result.ok, false);
    assert.ok(r.result.failures.some((x) => x.code === "SELF_TRANSFER" || x.code === "DUPLICATE_PARTICIPANT"));
  });
});

/* ===================================================================== */
/* §5/§17 — reconstruction immutability & nonparticipant isolation        */
/* ===================================================================== */

describe("audit §5/§17 — reconstruction immutability & nonparticipant isolation", () => {
  const teams: StdTeamSpec[] = [
    { slug: "A", flex: { id: "A_flex", pos: "RB", pts: 10 } },
    { slug: "B", flex: { id: "B_flex", pos: "WR", pts: 12 } },
    { slug: "N", flex: { id: "N_flex", pos: "TE", pts: 10 } },
  ];
  const mkFix = () => {
    const f = scene(teams, [xfer("A", "B", "A_flex"), xfer("B", "A", "B_flex")]);
    f.input.participants = f.input.participants.filter((p) => p.manager.manager_slug !== "N");
    f.input.normalized.participant_manager_ids = [MID("A"), MID("B")];
    return f;
  };

  it("evaluate only rebuilds the trade participants; N is untouched; repeat eval is identical", () => {
    const f = mkFix();
    const nBefore = JSON.stringify(f.rosters.get(MID("N")));
    const out1 = evaluateTrade(f.input);
    const out2 = evaluateTrade(f.input);
    assert.deepEqual(Object.keys(out1.participants).sort(), ["A", "B"]);
    assert.equal(JSON.stringify(f.rosters.get(MID("N"))), nBefore);
    assert.deepEqual(out1.participants.A!.roster_utility_components, out2.participants.A!.roster_utility_components);
    assert.deepEqual(out1.participants.B!, out2.participants.B!);
  });

  it("the pre-trade roster object is not mutated by reconstruction", () => {
    const f = mkFix();
    const aBefore = JSON.stringify(f.rosters.get(MID("A")));
    reconstructRosters(f.input.normalized, f.rosters);
    reconstructRosters(f.input.normalized, f.rosters);
    assert.equal(JSON.stringify(f.rosters.get(MID("A"))), aBefore);
  });
});

/* ===================================================================== */
/* §6 — marginal starter value is the RECOMPUTED lineup effect (A–E)      */
/* ===================================================================== */

describe("audit §6 — marginal starter value is the recomputed lineup effect", () => {
  it("Fixture A — incoming WR (15) upgrading a 14-pt FLEX has marginal value ≈ +1, not +15", () => {
    const f = scene(
      [
        { slug: "X", flex: { id: "X_flex", pos: "WR", pts: 14 }, bench: [{ id: "X_junk", pos: "RB", pts: 2 }] },
        { slug: "Y", flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "IN_wr", pos: "WR", pts: 15 }] },
      ],
      [xfer("X", "Y", "X_junk"), xfer("Y", "X", "IN_wr")],
    );
    const x = evaluateTrade(f.input).participants.X!;
    assert.equal(x.starter_points_delta_status, "RESOLVED");
    assert.ok(Math.abs(x.starter_points_delta! - 1) < 0.01, `expected ~+1, got ${x.starter_points_delta}`);
    assert.deepEqual(x.lineup_displacement.entered_starting_lineup, ["IN_wr"]);
    assert.deepEqual(x.lineup_displacement.left_starting_lineup, ["X_flex"]);
    assert.deepEqual(x.lineup_displacement.moved_to_bench, ["X_flex"]);
  });

  it("Fixture B — bench-only acquisition: starter delta ≈ 0, bench value rises", () => {
    const f = scene(
      [
        { slug: "X", flex: { id: "X_flex", pos: "RB", pts: 13 }, bench: [{ id: "X_junk", pos: "WR", pts: 3 }] },
        { slug: "Y", flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "IN_bench", pos: "WR", pts: 9 }] },
      ],
      [xfer("X", "Y", "X_junk"), xfer("Y", "X", "IN_bench")],
    );
    const x = evaluateTrade(f.input).participants.X!;
    assert.ok(Math.abs(x.starter_points_delta!) < 0.01, `starter delta ~0, got ${x.starter_points_delta}`);
    assert.ok(x.bench_value_delta > 0, `bench value should rise, got ${x.bench_value_delta}`);
    assert.deepEqual(x.lineup_displacement.entered_starting_lineup, []);
  });

  it("Fixture C — trading away a never-starting bench player costs ≈ 0 starter points", () => {
    const f = scene(
      [
        { slug: "X", flex: { id: "X_flex", pos: "RB", pts: 15 }, bench: [{ id: "X_deep", pos: "RB", pts: 9 }] },
        GENERIC("Y"),
      ],
      [xfer("X", "Y", "X_deep")],
    );
    const x = evaluateTrade(f.input).participants.X!;
    assert.ok(Math.abs(x.starter_points_delta!) < 0.01, `starter loss should be ~0 (not -9), got ${x.starter_points_delta}`);
  });

  it("Fixture D — acquiring an RB triggers an RB2→FLEX→bench chain the optimizer captures", () => {
    // X: gRB1 20, gRB2 19, FLEX X_wrflex 11. Acquire IN_rb 22.
    // after: RB1 22, RB2 20, FLEX 19 -> delta = (22+20+19)-(20+19+11) = +11
    const f = scene(
      [
        { slug: "X", flex: { id: "X_wrflex", pos: "WR", pts: 11 }, bench: [{ id: "X_junk", pos: "TE", pts: 2 }], lockPts: { RB1: 20, RB2: 19 } },
        { slug: "Y", flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "IN_rb", pos: "RB", pts: 22 }] },
      ],
      [xfer("X", "Y", "X_junk"), xfer("Y", "X", "IN_rb")],
    );
    const x = evaluateTrade(f.input).participants.X!;
    assert.ok(Math.abs(x.starter_points_delta! - 11) < 0.01, `expected +11 chain, got ${x.starter_points_delta}`);
    assert.ok(x.lineup_displacement.entered_starting_lineup.includes("IN_rb"));
    assert.ok(x.lineup_displacement.moved_to_bench.includes("X_wrflex"));
  });

  it("Fixture E — a multi-eligible incoming player is placed by the shared slot matcher", () => {
    const f = scene(
      [
        { slug: "X", flex: { id: "X_flex", pos: "WR", pts: 8 } },
        { slug: "Y", flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "IN_multi", pos: "RB", pts: 16, eligible: ["RB", "WR"] }] },
      ],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN_multi")],
    );
    const x = evaluateTrade(f.input).participants.X!;
    assert.ok(x.after.optimal_starters.includes("IN_multi"));
    assert.ok(x.starter_points_delta! > 7);
  });
});

/* ===================================================================== */
/* §8 — VOR exposed alongside projection delta, not collapsed             */
/* ===================================================================== */

describe("audit §8 — VOR is exposed alongside projection delta, not collapsed", () => {
  it("a same-projection WR→RB swap keeps starter_points and starter_vor as independent components", () => {
    const f = scene(
      [
        { slug: "X", flex: { id: "X_wr", pos: "WR", pts: 13 } },
        { slug: "Y", flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "IN_rb", pos: "RB", pts: 13 }] },
      ],
      [xfer("X", "Y", "X_wr"), xfer("Y", "X", "IN_rb")],
    );
    const x = evaluateTrade(f.input).participants.X!;
    assert.ok(Math.abs(x.starter_points_delta!) < 0.01, `raw points ~0, got ${x.starter_points_delta}`);
    assert.equal(typeof x.roster_utility_components.starter_points, "number");
    assert.equal(typeof x.roster_utility_components.starter_vor, "number");
    assert.equal(x.starter_vor_delta, x.roster_utility_components.starter_vor);
  });
});

/* ===================================================================== */
/* §11/§12 — utility composition & acceptance                             */
/* ===================================================================== */

describe("audit §11/§12 — utility composition & acceptance", () => {
  const mk = (config?: Parameters<typeof resolveTradeConfig>[0]) => scene(
    [
      { slug: "X", flex: { id: "X_flex", pos: "WR", pts: 10 } },
      { slug: "Y", flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "IN_wr", pos: "WR", pts: 16 }] },
    ],
    [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN_wr")],
    { config },
  );

  it("roster_utility_delta equals the documented weighted sum of its components", () => {
    const cfg = resolveTradeConfig();
    const x = evaluateTrade(mk().input).participants.X!;
    const c = x.roster_utility_components;
    const recomputed = Math.round((
      cfg.weights.starter_points * c.starter_points +
      cfg.weights.starter_vor * c.starter_vor +
      cfg.weights.bench_value * c.bench_value +
      cfg.weights.positional_need * c.positional_need
    ) * 100) / 100;
    assert.equal(x.roster_utility_delta, recomputed);
  });

  it("default composite does NOT double-count: starter_vor weight is 0", () => {
    assert.equal(DEFAULT_TRADE_CONFIG.weights.starter_vor, 0);
  });

  it("raising a weight moves utility in the expected direction (sensitivity)", () => {
    const baseX = evaluateTrade(mk().input).participants.X!;
    const heavyX = evaluateTrade(mk({ weights: { starter_vor: 1 } }).input).participants.X!;
    assert.ok(heavyX.roster_utility_delta > baseX.roster_utility_delta);
  });

  it("acceptance is monotonic and every class is reachable with default config", () => {
    const cfg = resolveTradeConfig();
    const order = ["HARD_REJECT", "REJECT", "RELUCTANT", "NEUTRAL", "ACCEPT", "STRONG_ACCEPT"];
    const seen = new Set<string>();
    let lastIdx = -1;
    for (const d of [-10, -5, -4, -3, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 3, 4, 10]) {
      const cls = classifyAcceptance(d, cfg);
      seen.add(cls);
      const idx = order.indexOf(cls);
      assert.ok(idx >= lastIdx, `non-monotonic at delta=${d}: ${cls}`);
      lastIdx = idx;
    }
    assert.deepEqual([...seen].sort(), [...order].sort(), "not every acceptance class is reachable");
  });

  it("threshold boundaries are inclusive/stable under epsilon", () => {
    const cfg = resolveTradeConfig();
    assert.equal(classifyAcceptance(cfg.thresholds.accept, cfg), "ACCEPT");
    assert.equal(classifyAcceptance(cfg.thresholds.accept - 1e-9, cfg), "NEUTRAL");
    assert.equal(classifyAcceptance(cfg.thresholds.strong_accept, cfg), "STRONG_ACCEPT");
    assert.equal(classifyAcceptance(cfg.thresholds.hard_reject, cfg), "HARD_REJECT");
    assert.equal(classifyAcceptance(cfg.thresholds.hard_reject + 1e-9, cfg), "REJECT");
  });

  it("resolveTradeConfig rejects non-monotonic thresholds", () => {
    assert.throws(() => resolveTradeConfig({ thresholds: { accept: 5, strong_accept: 3 } }));
  });
});

/* ===================================================================== */
/* §13 — acceptance floor is per-participant                              */
/* ===================================================================== */

describe("audit §13 — acceptance floor is per-participant, gains don't cross-subsidize", () => {
  // A gets a stud; C ships its only real FLEX starter for scraps; B ~flat.
  const f = scene(
    [
      { slug: "A", flex: { id: "A_flex", pos: "WR", pts: 6 } },
      { slug: "B", flex: { id: "B_flex", pos: "WR", pts: 11 }, bench: [{ id: "A_in", pos: "WR", pts: 22 }] },
      { slug: "C", flex: { id: "C_flex", pos: "RB", pts: 16 }, bench: [{ id: "C_scrap", pos: "WR", pts: 3 }] },
    ],
    [
      xfer("B", "A", "A_in"),
      xfer("A", "C", "A_flex"),
      xfer("C", "B", "C_flex"),
      xfer("B", "C", "B_flex"),
    ],
  );
  const out = evaluateTrade(f.input);

  it("C is below the acceptance floor even though total utility is positive", () => {
    const total = Object.values(out.participants).reduce((s, p) => s + p.roster_utility_delta, 0);
    assert.ok(out.participants.A!.roster_utility_delta > 0);
    assert.ok(out.participants.C!.roster_utility_delta < DEFAULT_TRADE_CONFIG.acceptance_floor,
      `C delta ${out.participants.C!.roster_utility_delta}`);
    assert.equal(out.participants.C!.above_acceptance_floor, false);
    assert.equal(out.trade_summary.all_teams_above_acceptance_floor, false);
    assert.ok(total > 0, "total is positive but does not rescue C");
  });

  it("viability is not HIGH/MODERATE when a participant is materially damaged", () => {
    assert.ok(["LOW", "NON_VIABLE"].includes(out.trade_summary.trade_viability));
  });
});

/* ===================================================================== */
/* §14 — fairness vs rationality stay distinct                            */
/* ===================================================================== */

describe("audit §14 — fairness and rationality stay distinct", () => {
  // Complementary-needs 3-way, NO bilateral pair:
  //   A: RB-deep, hole at WR2   -> ships buried A_rb4 to C, receives B_wr4
  //   B: WR-deep, hole at TE    -> ships buried B_wr4 to A, receives C_te2
  //   C: hole at RB2            -> ships C_te2 to B, receives A_rb4
  // `ship` = projected pts of each shipped player; `hole` = the weak lock each
  // team is trying to fill. Tuning these produces the three distribution shapes.
  function threeWay(ship: [number, number, number], hole: [number, number, number]) {
    const [sA, sB, sC] = ship;
    const [hA, hB, hC] = hole;
    return scene(
      [
        { slug: "A", flex: { id: "A_flex", pos: "RB", pts: 16 }, bench: [{ id: "A_rb4", pos: "RB", pts: sA }], lockPts: { WR2: hA } },
        { slug: "B", flex: { id: "B_flex", pos: "WR", pts: 16 }, bench: [{ id: "B_wr4", pos: "WR", pts: sB }], lockPts: { TE: hB } },
        { slug: "C", flex: { id: "C_flex", pos: "WR", pts: 14 }, bench: [{ id: "C_te2", pos: "TE", pts: sC }], lockPts: { RB2: hC, TE: 13 } },
      ],
      [xfer("A", "C", "A_rb4"), xfer("C", "B", "C_te2"), xfer("B", "A", "B_wr4")],
    );
  }
  const summary = (ship: [number, number, number], hole: [number, number, number]) =>
    evaluateTrade(threeWay(ship, hole).input).trade_summary;

  it("even gains -> all rational, low imbalance, HIGH viability", () => {
    const s = summary([14, 14, 12], [6, 6, 6]);
    assert.equal(s.rationality.every_participant_rational, true);
    assert.equal(s.all_teams_above_acceptance_floor, true);
    assert.ok(s.fairness.imbalance_index < 0.34, `imbalance ${s.fairness.imbalance_index}`);
    assert.equal(s.largest_negative, null);
  });

  it("uneven but all-positive -> still rational for all, higher imbalance, still viable", () => {
    const even = summary([14, 14, 12], [6, 6, 6]);
    const s = summary([14, 14, 12], [2, 9, 5]); // A's hole is much deeper -> A gains most
    assert.equal(s.rationality.every_participant_rational, true);
    assert.ok(s.fairness.imbalance_index > even.fairness.imbalance_index);
    assert.ok(["HIGH", "MODERATE"].includes(s.trade_viability), s.trade_viability);
  });

  it("one big winner + one loser -> NOT rational for all, NON_VIABLE, loser identified", () => {
    // C ships its STARTING TE (18) for a weak RB (8) -> C is damaged.
    const s = summary([8, 14, 18], [6, 6, 6]);
    assert.equal(s.rationality.every_participant_rational, false);
    assert.equal(s.trade_viability, "NON_VIABLE");
    assert.equal(s.largest_negative, "C");
    assert.equal(s.all_teams_above_acceptance_floor, false);
    assert.ok(s.fairness.imbalance_index > summary([14, 14, 12], [6, 6, 6]).fairness.imbalance_index);
  });
});

/* ===================================================================== */
/* §15/§16 — order invariance & trade direction                           */
/* ===================================================================== */

describe("audit §15/§16 — order invariance and trade direction", () => {
  const build = (teamOrder: string[], transfers: NormalizedProposal["transfers"]) => {
    const specs: Record<string, StdTeamSpec> = {
      A: { slug: "A", flex: { id: "A_f", pos: "WR", pts: 9 }, bench: [{ id: "A_x", pos: "RB", pts: 14 }] },
      B: { slug: "B", flex: { id: "B_f", pos: "WR", pts: 9 }, bench: [{ id: "B_y", pos: "WR", pts: 13 }] },
    };
    return scene(teamOrder.map((s) => specs[s]!), transfers);
  };

  it("swapping participant order AND transfer order leaves every numeric result identical", () => {
    const o1 = evaluateTrade(build(["A", "B"], [xfer("A", "B", "A_x"), xfer("B", "A", "B_y")]).input);
    const o2 = evaluateTrade(build(["B", "A"], [xfer("B", "A", "B_y"), xfer("A", "B", "A_x")]).input);
    for (const slug of ["A", "B"]) {
      assert.equal(o1.participants[slug]!.roster_utility_delta, o2.participants[slug]!.roster_utility_delta);
      assert.deepEqual(o1.participants[slug]!.roster_utility_components, o2.participants[slug]!.roster_utility_components);
      assert.equal(o1.participants[slug]!.acceptance, o2.participants[slug]!.acceptance);
    }
    assert.equal(o1.trade_summary.trade_viability, o2.trade_summary.trade_viability);
    assert.equal(o1.trade_summary.largest_beneficiary, o2.trade_summary.largest_beneficiary);
    assert.equal(o1.trade_summary.utility_gain_variance, o2.trade_summary.utility_gain_variance);
  });

  it("reversing the ownership operation produces a different roster result", () => {
    // Forward: A gets B_y(WR 14) at FLEX, B gets A_x(RB 14). Reverse: swap who ends with which.
    const symA: StdTeamSpec = { slug: "A", flex: { id: "A_f", pos: "WR", pts: 9 }, bench: [{ id: "A_x", pos: "RB", pts: 14 }] };
    const symB: StdTeamSpec = { slug: "B", flex: { id: "B_f", pos: "WR", pts: 9 }, bench: [{ id: "B_y", pos: "WR", pts: 14 }] };
    const fwd = scene([symA, symB], [xfer("A", "B", "A_x"), xfer("B", "A", "B_y")]);
    const rev = scene(
      [
        { slug: "A", flex: { id: "A_f", pos: "WR", pts: 9 }, bench: [{ id: "B_y", pos: "WR", pts: 14 }] },
        { slug: "B", flex: { id: "B_f", pos: "WR", pts: 9 }, bench: [{ id: "A_x", pos: "RB", pts: 14 }] },
      ],
      [xfer("A", "B", "B_y"), xfer("B", "A", "A_x")],
    );
    const fa = evaluateTrade(fwd.input).participants.A!;
    const ra = evaluateTrade(rev.input).participants.A!;
    const nonLock = (ids: string[]) => ids.filter((id) => !id.startsWith("A_QB") && !/^A_(RB|WR)\d$/.test(id) && !/^A_(TE|K|DEF)$/.test(id));
    assert.notDeepEqual(nonLock(fa.after.optimal_starters), nonLock(ra.after.optimal_starters));
  });
});

/* ===================================================================== */
/* §10 — positional-need impact is roster-specific                        */
/* ===================================================================== */

describe("audit §10 — positional-need impact is roster-specific", () => {
  it("filling a genuine RB hole reports IMPROVES_NEED at RB (roster-specific, not a generic label)", () => {
    // X's RB2 slot is a 2-pt scrub -> RB is CRITICAL for this roster specifically.
    const xTeam: StdTeamSpec = {
      slug: "X",
      flex: { id: "X_wrflex", pos: "WR", pts: 11 },
      bench: [{ id: "X_dep", pos: "WR", pts: 7 }],
      lockPts: { RB1: 15, RB2: 2 },
    };
    const f = scene(
      [xTeam, { slug: "Y", flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "IN_rb", pos: "RB", pts: 17 }] }],
      [xfer("X", "Y", "X_dep"), xfer("Y", "X", "IN_rb")],
    );
    const x = evaluateTrade(f.input).participants.X!;
    const rbChange = x.positional_need_changes.find((c) => c.position === "RB");
    assert.ok(rbChange, `expected an RB need change: ${JSON.stringify(x.positional_need_changes)}`);
    assert.equal(rbChange!.kind, "IMPROVES_NEED");
    assert.equal(rbChange!.before_severity, "critical");
    // and the trade also honestly reports the WR depth it cost X
    assert.ok(x.positional_need_changes.some((c) => c.position === "WR" && c.kind === "WORSENS_POSITION"));
    assert.ok(x.roster_utility_components.positional_need > 0, `net need component ${x.roster_utility_components.positional_need}`);
  });

  it("trading away the only viable starter at a scarce position is rejected as illegal", () => {
    const f = scene(
      [
        { slug: "X", flex: { id: "X_flex", pos: "WR", pts: 10 } },
        { slug: "Y", flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "IN_wr", pos: "WR", pts: 12 }] },
      ],
      [],
    );
    // X trades away its only TE.
    const r = validateTrade(f.resolution(
      [{ input: "X", slug: "X" }, { input: "Y", slug: "Y" }],
      [{ from: "X", to: "Y", pid: "X_TE", cid: "X_TE" }, { from: "Y", to: "X", pid: "IN_wr", cid: "IN_wr" }],
    ));
    assert.ok(r.result.failures.some((x) => x.code === "POST_TRADE_ROSTER_ILLEGAL"), JSON.stringify(r.result.failures));
  });
});

/* ===================================================================== */
/* §19 — degraded states surfaced, not masked                             */
/* ===================================================================== */

describe("audit §19 — degraded inputs are surfaced, not masked as full confidence", () => {
  it("a missing projection on a would-be starter yields UNRESOLVED starter delta + TRADE_ANALYSIS_DEGRADED", () => {
    const built = [
      stdTeam({ slug: "X", flex: { id: "X_f", pos: "WR", pts: 6 } }),
      stdTeam({ slug: "Y", flex: { id: "Y_f", pos: "WR", pts: 8 }, bench: [{ id: "IN_unk", pos: "WR", pts: 15 }] }),
    ];
    // drop IN_unk's projection entirely
    const projections = built.flatMap((b) => b.projections).filter((p) => p.canonical_player_id !== "IN_unk");
    const f = tradeFixture({
      teams: built.map((b) => b.team),
      players: built.flatMap((b) => b.players),
      projections,
      freeAgents: FA, faProjections: FA_PROJ,
      transfers: [xfer("X", "Y", "X_f"), xfer("Y", "X", "IN_unk")],
    });
    const out = evaluateTrade(f.input);
    const x = out.participants.X!;
    assert.equal(x.starter_points_delta_status, "UNRESOLVED");
    assert.equal(x.starter_points_delta, null);
    assert.ok(x.diagnostics.some((d) => d.code === "STARTER_PROJECTION_UNAVAILABLE"));
    assert.ok(x.diagnostics.some((d) => d.code === "TRADE_ANALYSIS_DEGRADED"));
    assert.ok(out.diagnostics.some((d) => d.code === "TRADE_ANALYSIS_DEGRADED"));
  });

  it("PROJECTIONS_PARTIAL status is propagated as a top-level diagnostic", () => {
    const f = scene(
      [
        { slug: "X", flex: { id: "X_f", pos: "WR", pts: 6 } },
        { slug: "Y", flex: { id: "Y_f", pos: "WR", pts: 8 }, bench: [{ id: "IN_wr", pos: "WR", pts: 15 }] },
      ],
      [xfer("X", "Y", "X_f"), xfer("Y", "X", "IN_wr")],
    );
    f.input.projections_status = "PROJECTIONS_PARTIAL";
    const out = evaluateTrade(f.input);
    assert.ok(out.diagnostics.some((d) => d.code === "PROJECTIONS_PARTIAL"));
  });
});

/* ===================================================================== */
/* §18 — determinism                                                      */
/* ===================================================================== */

/* ===================================================================== */
/* §20/§24 — analyzeTrade orchestrator degrades gracefully                */
/* ===================================================================== */

describe("audit §20 — analyzeTrade degradation & contract", () => {
  it("an unknown league yields a graceful status + versioned envelope, no stack leak", async () => {
    const r = await analyzeTrade({
      league: "___no_such_league___",
      participants: [{ manager_id: "a" }, { manager_id: "b" }],
      transfers: [{ from_manager_id: "a", to_manager_id: "b", asset: { type: "PLAYER", player_id: "1" } }],
    });
    assert.ok(["VALIDATION_FAILED", "CONTEXT_UNAVAILABLE"].includes(r.status));
    assert.equal(r.trade_version, TRADE_ENGINE_VERSION);
    assert.equal(Object.keys(r.participants).length, 0);
    assert.equal(r.trade_summary, null);
    assert.ok(r.diagnostics.every((d) => !/\bat \/|\.ts:\d+:\d+/.test(d.message)), "no stack trace in a diagnostic");
  });

  it("an empty league slug is a validation failure, not a throw", async () => {
    const r = await analyzeTrade({ league: "", participants: [{ manager_id: "a" }, { manager_id: "b" }], transfers: [] });
    assert.equal(r.status, "VALIDATION_FAILED");
  });
});

describe("audit §18 — determinism", () => {
  it("identical inputs -> byte-identical results across 5 runs", () => {
    const mk = () => scene(
      [
        { slug: "X", flex: { id: "X_f", pos: "WR", pts: 6 } },
        { slug: "Y", flex: { id: "Y_f", pos: "WR", pts: 8 }, bench: [{ id: "IN_wr", pos: "WR", pts: 15 }] },
      ],
      [xfer("X", "Y", "X_f"), xfer("Y", "X", "IN_wr")],
    );
    const golden = JSON.stringify(evaluateTrade(mk().input).participants);
    for (let i = 0; i < 5; i += 1) assert.equal(JSON.stringify(evaluateTrade(mk().input).participants), golden);
  });
});
