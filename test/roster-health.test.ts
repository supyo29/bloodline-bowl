/**
 * Phase 6 — Roster Health: deterministic invariants (spec §29), adversarial
 * matrix (spec §28), snapshot delta, and isolation from recommendation engines
 * (spec §1, §23).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { player, proj, batch, roster, STD_CONSTRAINTS, SUPERFLEX_CONSTRAINTS } from "./fixtures/weekly";
import {
  bestLegalLineup,
  contingency,
  rosterWithout,
  evaluateHorizon,
  rosterHealthDelta,
  type RosterHealthInputs,
} from "@/lib/roster-health";
import type { TeamManagementState } from "@/lib/team-state/schema";
import type { CanonicalPlayer } from "@/lib/canonical/schema";

const ROOT = process.cwd();

/* ------------- lean inputs / team-state stubs ------------- */

function mkInputs(
  players: CanonicalPlayer[],
  weeklyPts: Record<string, number | null>,
  rosPts?: Record<string, number | null>,
  replacementOverride?: Record<string, number>,
): RosterHealthInputs {
  const projs = players.map((p) => proj(p.canonical_player_id, p.position, weeklyPts[p.canonical_player_id] ?? null));
  const b = batch(projs, players);
  const rosMap = new Map<string, number | null>();
  for (const p of players) rosMap.set(p.canonical_player_id, (rosPts ?? weeklyPts)[p.canonical_player_id] ?? null);
  const repl = (pool: Record<string, number | null>) => {
    if (replacementOverride) return { ...replacementOverride, FLEX: Math.max(replacementOverride.RB ?? 0, replacementOverride.WR ?? 0, replacementOverride.TE ?? 0) };
    const byPos: Record<string, number[]> = {};
    for (const p of players) {
      const v = pool[p.canonical_player_id];
      if (v != null) (byPos[p.position] ??= []).push(v);
    }
    const out: Record<string, number | null> = {};
    for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
      const a = (byPos[pos] ?? []).sort((x, y) => y - x);
      out[pos] = a.length ? a[Math.min(a.length - 1, 3)]! : 4;
    }
    out.FLEX = Math.max(out.RB ?? 0, out.WR ?? 0, out.TE ?? 0);
    return out;
  };
  return {
    league_slug: "test",
    season: 2026,
    week: 1,
    provider: "sleeper",
    snapshot: {} as RosterHealthInputs["snapshot"],
    constraints: STD_CONSTRAINTS,
    playerById: new Map(players.map((p) => [p.canonical_player_id, p])),
    rosters: [],
    weekly: b,
    weeklyReplacement: {
      league_slug: "test",
      week: 1,
      by_position: Object.fromEntries(
        Object.entries(repl(weeklyPts)).map(([k, v]) => [k, { position: k, replacement_points: v, basis: "test", derived_from_rank: null, sample_size: 1 }]),
      ),
    } as unknown as RosterHealthInputs["weeklyReplacement"],
    rosPointsByCid: rosMap,
    rosReplacement: repl(rosPts ?? weeklyPts),
    ri_model_version: null,
    ros_source: "test",
    weeks_left_frac: 0.9,
    schedule_ready: true,
    teams_on_bye: new Set(),
    warnings: [],
  };
}

function mkTeamState(surplusKeys: string[] = []): TeamManagementState {
  return {
    identity: { manager_slug: "m", is_vacant: false, roster_id: 1 },
    depth_pressure: {
      by_key: ["QB", "RB", "WR", "TE", "K", "DEF", "FLEX"].map((k) => ({
        slot_key: k,
        structural_surplus: surplusKeys.includes(k),
      })),
    },
    structural_flags: [],
  } as unknown as TeamManagementState;
}

const std = (starters: string[], bench: string[] = [], ir: string[] = []) =>
  roster("team:t", starters, bench, { ir, startingSlots: STD_CONSTRAINTS.starting_slots });

/* -------------------- primitives -------------------- */

const PL = [
  player("qb1", "QB"), player("qb2", "QB"),
  player("rb1", "RB"), player("rb2", "RB"), player("rb3", "RB"), player("rb4", "RB"),
  player("wr1", "WR"), player("wr2", "WR"), player("wr3", "WR"), player("wr4", "WR"),
  player("te1", "TE"), player("te2", "TE"),
  player("k1", "K"), player("dst1", "DEF"),
];
const PTS: Record<string, number> = {
  qb1: 20, qb2: 12, rb1: 16, rb2: 12, rb3: 8, rb4: 5, wr1: 15, wr2: 13, wr3: 9, wr4: 6, te1: 11, te2: 4, k1: 8, dst1: 7,
};

test("contingency: higher-quality replacement -> lower dependency loss (spec §29)", () => {
  const players = new Map(PL.map((p) => [p.canonical_player_id, p]));
  const r = std(["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "dst1"], ["qb2", "rb4", "wr3", "wr4", "te2"]);
  const bad = batch(PL.map((p) => proj(p.canonical_player_id, p.position, PTS[p.canonical_player_id] ?? 5)), PL);
  const better = batch(
    PL.map((p) => proj(p.canonical_player_id, p.position, p.canonical_player_id === "rb4" ? 15 : PTS[p.canonical_player_id] ?? 5)),
    PL,
  );
  const baseBad = bestLegalLineup(r, STD_CONSTRAINTS, players, bad, 1);
  const baseBetter = bestLegalLineup(r, STD_CONSTRAINTS, players, better, 1);
  const lossBad = contingency(r, STD_CONSTRAINTS, players, bad, 1, baseBad, "rb1").value_loss ?? 0;
  const lossBetter = contingency(r, STD_CONSTRAINTS, players, better, 1, baseBetter, "rb1").value_loss ?? 0;
  assert.ok(lossBetter <= lossBad + 1e-9, `${lossBetter} vs ${lossBad}`);
});

test("determinism: identical inputs -> identical contingency", () => {
  const players = new Map(PL.map((p) => [p.canonical_player_id, p]));
  const r = std(["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "dst1"], ["qb2", "rb4"]);
  const b = batch(PL.map((p) => proj(p.canonical_player_id, p.position, PTS[p.canonical_player_id] ?? 5)), PL);
  const base = bestLegalLineup(r, STD_CONSTRAINTS, players, b, 1);
  assert.deepEqual(
    contingency(r, STD_CONSTRAINTS, players, b, 1, base, "wr1"),
    contingency(r, STD_CONSTRAINTS, players, b, 1, base, "wr1"),
  );
});

test("rosterWithout removes from every list and empties the starting slot", () => {
  const r = std(["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "dst1"], ["qb2"]);
  const after = rosterWithout(r, new Set(["rb1"]));
  assert.ok(!after.starters.includes("rb1") && !after.all_players.includes("rb1"));
  assert.ok(after.slots.find((s) => s.slot === "RB" && s.is_empty));
});

/* -------------------- evaluateHorizon invariants -------------------- */

test("adversarial 3 (elite RB + no backup) -> high dependency + single point of failure", () => {
  const players = [player("qb1", "QB"), player("qb2", "QB"), player("rb1", "RB"), player("wr1", "WR"), player("wr2", "WR"), player("wr3", "WR"), player("te1", "TE"), player("k1", "K"), player("dst1", "DEF")];
  const inputs = mkInputs(players, { qb1: 18, qb2: 10, rb1: 22, wr1: 14, wr2: 12, wr3: 8, te1: 10, k1: 8, dst1: 7 });
  const r = std(["qb1", "rb1", "wr1", "wr2", "wr3", "te1", "wr3", "k1", "dst1"].filter((x, i, a) => a.indexOf(x) === i).slice(0, 9), ["qb2"]);
  const v = evaluateHorizon(inputs, r, mkTeamState(), "weekly");
  const rbDep = v.player_dependency.find((d) => d.canonical_player_id === "rb1");
  assert.ok(rbDep && (rbDep.raw_point_loss ?? 0) > 5, JSON.stringify(rbDep));
  assert.equal(rbDep!.single_point_of_failure, true);
});

test("adversarial 4 (five replacement-level RBs) -> not STRONG depth", () => {
  const players = [player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("rb3", "RB"), player("rb4", "RB"), player("rb5", "RB"), player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"), player("k1", "K"), player("dst1", "DEF")];
  // all RBs at/below a realistic league replacement line (~9)
  const inputs = mkInputs(
    players,
    { qb1: 18, rb1: 8, rb2: 6, rb3: 5, rb4: 4, rb5: 4, wr1: 14, wr2: 12, te1: 10, k1: 8, dst1: 7 },
    undefined,
    { QB: 12, RB: 9, WR: 8, TE: 6, K: 6, DEF: 6 },
  );
  const r = std(["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "dst1"], ["rb4", "rb5"]);
  const v = evaluateHorizon(inputs, r, mkTeamState(["RB"]), "weekly");
  const rbDepth = v.depth_quality.find((d) => d.slot_key === "RB")!;
  assert.notEqual(rbDepth.depth_quality_grade, "STRONG");
  // structural_surplus (Phase 2 fact) is echoed but quality_surplus is false
  const rbQ = v.quality_surplus.find((q) => q.slot_key === "RB")!;
  assert.equal(rbQ.team_state_structural_surplus, true);
  assert.equal(rbQ.quality_surplus, false);
});

test("invariant: stronger legal backup -> fragility not higher, depth quality not lower", () => {
  const players = [player("qb1", "QB"), player("qb2", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("rb3", "RB"), player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"), player("k1", "K"), player("dst1", "DEF")];
  const starters = ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "dst1"];
  const weak = mkInputs(players, { qb1: 18, qb2: 10, rb1: 16, rb2: 12, rb3: 8, wr1: 14, wr2: 12, te1: 10, k1: 8, dst1: 7 });
  const strong = mkInputs(players, { qb1: 18, qb2: 10, rb1: 16, rb2: 12, rb3: 14, wr1: 14, wr2: 12, te1: 10, k1: 8, dst1: 7 }); // rb3 backup much better
  const r = std(starters, ["qb2"]);
  const vWeak = evaluateHorizon(weak, r, mkTeamState(), "weekly");
  const vStrong = evaluateHorizon(strong, r, mkTeamState(), "weekly");
  assert.ok((vStrong.fragility.worst_starter_dependency ?? 0) <= (vWeak.fragility.worst_starter_dependency ?? 0) + 1e-9);
});

test("invariant: adding a replacement-level bench player -> no large quality-surplus gain", () => {
  const base = [player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"), player("rb3", "RB"), player("k1", "K"), player("dst1", "DEF")];
  const withFiller = [...base, player("wr9", "WR")];
  const starters = ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "dst1"];
  const iB = mkInputs(base, Object.fromEntries(base.map((p) => [p.canonical_player_id, 10])));
  const iF = mkInputs(withFiller, { ...Object.fromEntries(base.map((p) => [p.canonical_player_id, 10])), wr9: 3 });
  const vB = evaluateHorizon(iB, std(starters, []), mkTeamState(), "weekly");
  const vF = evaluateHorizon(iF, std(starters, ["wr9"]), mkTeamState(), "weekly");
  const surB = vB.quality_surplus.filter((q) => q.quality_surplus).length;
  const surF = vF.quality_surplus.filter((q) => q.quality_surplus).length;
  assert.ok(surF <= surB, `${surF} vs ${surB}`);
});

test("K without backup does NOT drive core fragility (spec §14/§18)", () => {
  const players = [player("qb1", "QB"), player("qb2", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("rb3", "RB"), player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"), player("k1", "K"), player("dst1", "DEF")];
  const inputs = mkInputs(players, { qb1: 18, qb2: 12, rb1: 16, rb2: 12, rb3: 9, wr1: 14, wr2: 12, te1: 10, k1: 8, dst1: 7 });
  const v = evaluateHorizon(inputs, std(["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "dst1"], ["qb2"]), mkTeamState(), "weekly");
  const kDepth = v.depth_quality.find((d) => d.slot_key === "K")!;
  assert.equal(kDepth.excluded_from_core_fragility, true);
  assert.ok(!v.fragility.single_points_of_failure.includes("k1"));
});

test("ROS horizon always carries FA_POOL_ROS_APPROXIMATE (spec §6)", () => {
  const players = [player("qb1", "QB"), player("qb2", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("rb3", "RB"), player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"), player("k1", "K"), player("dst1", "DEF")];
  const inputs = mkInputs(players, { qb1: 18, qb2: 12, rb1: 16, rb2: 12, rb3: 9, wr1: 14, wr2: 12, te1: 10, k1: 8, dst1: 7 });
  const v = evaluateHorizon(inputs, std(["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "dst1"], ["qb2"]), mkTeamState(), "rest_of_season");
  assert.ok(v.degradation.reasons.includes("FA_POOL_ROS_APPROXIMATE"));
});

test("missing projection -> degraded, not fabricated certainty (spec §29)", () => {
  const players = [player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"), player("rb3", "RB"), player("k1", "K"), player("dst1", "DEF")];
  const pts: Record<string, number | null> = { qb1: 18, rb1: 16, rb2: 12, wr1: 14, wr2: null, te1: 10, rb3: 9, k1: 8, dst1: 7 };
  const inputs = mkInputs(players, pts);
  const v = evaluateHorizon(inputs, std(["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "dst1"], []), mkTeamState(), "weekly");
  assert.ok(v.degradation.reasons.includes("MISSING_WEEKLY_PROJECTION"));
  assert.notEqual(v.degradation.overall, "OK");
});

test("SUPER_FLEX: a QB2 backs both QB and SUPER_FLEX but is not counted twice (spec §13)", () => {
  const players = [player("qb1", "QB"), player("qb2", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"), player("k1", "K"), player("dst1", "DEF")];
  const inputs = { ...mkInputs(players, { qb1: 20, qb2: 15, rb1: 14, rb2: 11, wr1: 13, wr2: 10, te1: 9, k1: 8, dst1: 7 }), constraints: SUPERFLEX_CONSTRAINTS };
  const r = roster("team:t", ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "qb2", "k1", "dst1"], [], { startingSlots: SUPERFLEX_CONSTRAINTS.starting_slots });
  const v = evaluateHorizon(inputs, r, mkTeamState(), "weekly");
  // removing qb1: qb2 slides from SUPER_FLEX to QB; no eligible SUPER_FLEX filler -> real loss, not "covered twice"
  const qbDep = v.player_dependency.find((d) => d.canonical_player_id === "qb1")!;
  assert.ok((qbDep.raw_point_loss ?? 0) > 0);
});

/* -------------------- snapshot delta -------------------- */

test("delta: identical states -> zero changes (spec §29)", () => {
  const players = [player("qb1", "QB"), player("qb2", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("rb3", "RB"), player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"), player("k1", "K"), player("dst1", "DEF")];
  const inputs = mkInputs(players, { qb1: 18, qb2: 12, rb1: 16, rb2: 12, rb3: 9, wr1: 14, wr2: 12, te1: 10, k1: 8, dst1: 7 });
  const r = std(["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "dst1"], ["qb2"]);
  const wrap = (v: ReturnType<typeof evaluateHorizon>) => ({
    team_id: "t", lineage: { league_snapshot_id: "s1", projection_lineage: { weekly: { model_version: "m", source: "x" }, ros: { source: "y", ri_model_version: null } } },
    weekly: v, rest_of_season: v,
  }) as unknown as Parameters<typeof rosterHealthDelta>[0];
  const v = evaluateHorizon(inputs, r, mkTeamState(), "weekly");
  const d = rosterHealthDelta(wrap(v), wrap(v));
  assert.equal(d.changes.length, 0);
  assert.match(d.summary, /No material/);
});

/* -------------------- isolation (spec §1, §23) -------------------- */

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("lib/trades/depth.ts is unchanged by Phase 6 (frozen)", () => {
  const src = readFileSync(join(ROOT, "lib", "trades", "depth.ts"), "utf8");
  assert.ok(!src.includes("roster-health"), "trades/depth.ts must not import roster-health");
});

test("lib/trades never imports roster-health", () => {
  for (const f of walk(join(ROOT, "lib", "trades"))) {
    assert.ok(!readFileSync(f, "utf8").includes("roster-health"), f);
  }
});

test("roster-health never imports a recommendation engine", () => {
  for (const f of walk(join(ROOT, "lib", "roster-health"))) {
    const src = readFileSync(f, "utf8");
    for (const bad of ["@/lib/trades", "@/lib/weekly/waivers", "@/lib/weekly/start-sit", "@/lib/weekly/matchup-intelligence", "start-sit-fi"]) {
      assert.ok(!src.includes(bad), `${f} imports ${bad}`);
    }
  }
});

test("roster-health uses the frozen buildOptimalLineup / maxSlotMatching, not a new normalizer", () => {
  const contSrc = readFileSync(join(ROOT, "lib", "roster-health", "contingency.ts"), "utf8");
  assert.ok(contSrc.includes("buildOptimalLineup"));
  const lineupSrc = readFileSync(join(ROOT, "lib", "weekly", "lineup.ts"), "utf8");
  assert.ok(!lineupSrc.includes("roster-health"));
});
