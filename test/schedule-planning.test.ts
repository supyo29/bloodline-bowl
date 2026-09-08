/**
 * Phase 7 — Schedule & Forward Planning: structure/value confidence separation
 * (spec §1), deterministic invariants (spec §30), adversarial matrix (spec §29),
 * planning delta (spec §22), and isolation from every recommendation engine
 * (spec §3, §26).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { player, proj, batch, roster, STD_CONSTRAINTS, SUPERFLEX_CONSTRAINTS } from "./fixtures/weekly";
import { buildWeekTimeline, planningDelta, type TimelineInput } from "@/lib/schedule-planning";
import type { FullSchedule } from "@/lib/schedule-planning";
import type { RosterHealthInputs } from "@/lib/roster-health";
import type { TeamManagementState } from "@/lib/team-state/schema";
import type { CanonicalPlayer } from "@/lib/canonical/schema";
import type { TeamSchedulePlan } from "@/lib/schedule-planning";

const ROOT = process.cwd();

/* ---------------- stubs ---------------- */

function mkInputs(
  players: CanonicalPlayer[],
  weeklyPts: Record<string, number | null>,
  rosPts?: Record<string, number | null>,
): RosterHealthInputs {
  const projs = players.map((p) => proj(p.canonical_player_id, p.position, weeklyPts[p.canonical_player_id] ?? null));
  const b = batch(projs, players);
  const rosMap = new Map<string, number | null>();
  for (const p of players) rosMap.set(p.canonical_player_id, (rosPts ?? mult(weeklyPts, 12))[p.canonical_player_id] ?? null);
  const repl = { QB: 12, RB: 8, WR: 8, TE: 6, K: 6, DEF: 6, FLEX: 8 };
  return {
    league_slug: "test",
    season: 2026,
    week: 5,
    provider: "sleeper",
    snapshot: {} as RosterHealthInputs["snapshot"],
    constraints: STD_CONSTRAINTS,
    playerById: new Map(players.map((p) => [p.canonical_player_id, p])),
    rosters: [],
    weekly: b,
    weeklyReplacement: {
      league_slug: "test",
      week: 5,
      by_position: Object.fromEntries(
        Object.entries(repl).map(([k, v]) => [k, { position: k, replacement_points: v, basis: "test", derived_from_rank: null, sample_size: 1 }]),
      ),
    } as unknown as RosterHealthInputs["weeklyReplacement"],
    rosPointsByCid: rosMap,
    rosReplacement: repl,
    ri_model_version: "ri-test",
    ros_source: "sleeper_season_rotowire_prorated",
    weeks_left_frac: 0.76,
    schedule_ready: true,
    teams_on_bye: new Set(),
    warnings: [],
  };
}

const mult = (r: Record<string, number | null>, k: number) =>
  Object.fromEntries(Object.entries(r).map(([id, v]) => [id, v == null ? null : v * k]));

function mkTeamState(): TeamManagementState {
  return {
    identity: { manager_slug: "m", is_vacant: false, roster_id: 1, canonical_team_id: "team:t", manager_display_name: "M", team_name: "T" },
    depth_pressure: { by_key: ["QB", "RB", "WR", "TE", "K", "DEF", "FLEX"].map((k) => ({ slot_key: k, structural_surplus: false })) },
    structural_flags: [],
    league: { playoff: { playoff_team_count: 6, playoff_start_week: 15, championship_week: 17 } },
  } as unknown as TeamManagementState;
}

function mkSchedule(
  byes: Record<number, string[]>,
  opponents: Record<number, Record<string, string>> = {},
  incomplete: number[] = [],
): FullSchedule {
  const byeByWeek = new Map<number, Set<string>>();
  const opponentByWeek = new Map<number, Record<string, string>>();
  for (let w = 1; w <= 18; w += 1) {
    if (!incomplete.includes(w)) byeByWeek.set(w, new Set(byes[w] ?? []));
    opponentByWeek.set(w, opponents[w] ?? { KC: "LV", LV: "KC", SF: "SEA", DAL: "NYG", BUF: "MIA" });
  }
  return {
    source: "test_schedule",
    byeByWeek,
    opponentByWeek,
    homeAwayByWeek: new Map(),
    incompleteWeeks: new Set(incomplete),
  };
}

const std = (starters: string[], bench: string[] = []) =>
  roster("team:t", starters, bench, { startingSlots: STD_CONSTRAINTS.starting_slots });

function mkTimelineInput(over: Partial<TimelineInput> & Pick<TimelineInput, "inputs" | "roster" | "schedule">): TimelineInput {
  return {
    teamState: mkTeamState(),
    currentWeek: 5,
    lastRegularWeek: 14,
    playoffWeeks: [15, 16, 17],
    fiVersion: "not_used",
    baselineDepthUsable: 0,
    ...over,
  };
}

const PL = [
  player("qb1", "QB", { team: "KC" }), player("qb2", "QB", { team: "SF" }),
  player("rb1", "RB", { team: "KC" }), player("rb2", "RB", { team: "DAL" }),
  player("rb3", "RB", { team: "BUF" }), player("rb4", "RB", { team: "LV" }),
  player("wr1", "WR", { team: "KC" }), player("wr2", "WR", { team: "SF" }),
  player("wr3", "WR", { team: "DAL" }), player("wr4", "WR", { team: "BUF" }),
  player("te1", "TE", { team: "KC" }), player("te2", "TE", { team: "LV" }),
  player("k1", "K", { team: "DAL" }), player("dst1", "DEF", { team: "SF" }),
];
const PTS: Record<string, number> = {
  qb1: 20, qb2: 14, rb1: 16, rb2: 13, rb3: 11, rb4: 7, wr1: 15, wr2: 13, wr3: 10, wr4: 8, te1: 11, te2: 5, k1: 8, dst1: 7,
};
const STARTERS = ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "dst1"];
const BENCH = ["qb2", "rb4", "wr3", "wr4", "te2"];

/* ---------------- spec §1: structure vs value ---------------- */

test("current week uses WEEKLY basis; future weeks use ROS_PROJECTION (spec §8)", () => {
  const tl = buildWeekTimeline(
    mkTimelineInput({ inputs: mkInputs(PL, PTS), roster: std(STARTERS, BENCH), schedule: mkSchedule({}) }),
  );
  assert.equal(tl[0]!.week, 5);
  assert.equal(tl[0]!.projection_basis, "WEEKLY");
  assert.equal(tl[0]!.value_confidence, "HIGH");
  for (const w of tl.slice(1)) {
    assert.equal(w.projection_basis, "ROS_PROJECTION");
    assert.ok(w.degradation.reasons.includes("ROS_PROJECTION_USED"));
    assert.notEqual(w.value_confidence, "HIGH");
  }
});

test("known schedule structure stays HIGH confidence even when value confidence is low (spec §1, §9, §30)", () => {
  const tl = buildWeekTimeline(
    mkTimelineInput({ inputs: mkInputs(PL, PTS), roster: std(STARTERS, BENCH), schedule: mkSchedule({ 13: ["KC"] }) }),
  );
  const wk13 = tl.find((w) => w.week === 13)!;
  assert.equal(wk13.structure_confidence, "HIGH");
  assert.equal(wk13.degradation.structure, "OK");
  assert.equal(wk13.value_confidence, "ROS_CONTEXT_ONLY"); // > MEDIUM_TERM out
  assert.equal(wk13.bye_player_count, 4); // qb1, rb1, wr1, te1 are all KC
});

test("SCHEDULE_WEEK_INCOMPLETE degrades structure but not into a fabricated bye (spec §29)", () => {
  const tl = buildWeekTimeline(
    mkTimelineInput({ inputs: mkInputs(PL, PTS), roster: std(STARTERS, BENCH), schedule: mkSchedule({}, {}, [9]) }),
  );
  const wk9 = tl.find((w) => w.week === 9)!;
  assert.equal(wk9.nfl_schedule_state, "SCHEDULE_WEEK_INCOMPLETE");
  assert.equal(wk9.structure_confidence, "LOW");
  assert.equal(wk9.bye_player_count, 0);
  assert.ok(wk9.degradation.reasons.includes("SCHEDULE_WEEK_INCOMPLETE"));
});

/* ---------------- spec §30 invariants ---------------- */

test("no byes anywhere -> every estimated_bye_loss is 0", () => {
  const tl = buildWeekTimeline(
    mkTimelineInput({ inputs: mkInputs(PL, PTS), roster: std(STARTERS, BENCH), schedule: mkSchedule({}) }),
  );
  for (const w of tl) assert.equal(w.estimated_bye_loss, 0);
});

test("removing a bye collision does not increase estimated_bye_loss (spec §30)", () => {
  const withCollision = buildWeekTimeline(
    mkTimelineInput({ inputs: mkInputs(PL, PTS), roster: std(STARTERS, BENCH), schedule: mkSchedule({ 10: ["KC", "DAL"] }) }),
  ).find((w) => w.week === 10)!;
  const fewer = buildWeekTimeline(
    mkTimelineInput({ inputs: mkInputs(PL, PTS), roster: std(STARTERS, BENCH), schedule: mkSchedule({ 10: ["KC"] }) }),
  ).find((w) => w.week === 10)!;
  assert.ok((fewer.estimated_bye_loss ?? 0) <= (withCollision.estimated_bye_loss ?? 0) + 1e-9);
});

test("deterministic: identical inputs -> identical timeline (spec §30)", () => {
  const mk = () =>
    buildWeekTimeline(
      mkTimelineInput({ inputs: mkInputs(PL, PTS), roster: std(STARTERS, BENCH), schedule: mkSchedule({ 7: ["KC"], 10: ["DAL"] }) }),
    );
  assert.deepEqual(JSON.parse(JSON.stringify(mk())), JSON.parse(JSON.stringify(mk())));
});

test("adding a legal strong backup does not worsen future coverage (spec §30)", () => {
  const thin = buildWeekTimeline(
    mkTimelineInput({ inputs: mkInputs(PL, PTS), roster: std(STARTERS, ["qb2"]), schedule: mkSchedule({ 8: ["KC"] }) }),
  ).find((w) => w.week === 8)!;
  const deep = buildWeekTimeline(
    mkTimelineInput({
      inputs: mkInputs([...PL, player("wr9", "WR", { team: "SEA" })], { ...PTS, wr9: 14 }),
      roster: std(STARTERS, ["qb2", "wr9"]),
      schedule: mkSchedule({ 8: ["KC"] }),
    }),
  ).find((w) => w.week === 8)!;
  assert.ok(deep.uncovered_slot_labels.length <= thin.uncovered_slot_labels.length);
  assert.ok((deep.estimated_bye_loss ?? 0) <= (thin.estimated_bye_loss ?? 0) + 1e-9);
});

test("playoff weeks come from league config, not weeks 15-17 assumption (spec §14, §30)", () => {
  const tl = buildWeekTimeline(
    mkTimelineInput({
      inputs: mkInputs(PL, PTS),
      roster: std(STARTERS, BENCH),
      schedule: mkSchedule({}),
      lastRegularWeek: 13,
      playoffWeeks: [14, 15, 16],
    }),
  );
  assert.deepEqual(tl.filter((w) => w.is_playoff_week).map((w) => w.week), [14, 15, 16]);
});

test("future ROS value is explicitly labelled (spec §8, §24, §30)", () => {
  const tl = buildWeekTimeline(
    mkTimelineInput({ inputs: mkInputs(PL, PTS), roster: std(STARTERS, BENCH), schedule: mkSchedule({}) }),
  );
  for (const w of tl.slice(1)) {
    assert.equal(w.value_source.ros_source, "sleeper_season_rotowire_prorated");
    assert.equal(w.value_source.ri_model_version, "ri-test");
  }
});

test("missing future projection -> degraded, not a fabricated weekly number (spec §24, §30)", () => {
  const pts = { ...PTS } as Record<string, number | null>;
  pts.rb2 = null;
  const inputs = mkInputs(PL, pts, { ...mult(PTS, 12), rb2: null });
  const tl = buildWeekTimeline(
    mkTimelineInput({ inputs, roster: std(STARTERS, BENCH), schedule: mkSchedule({}) }),
  );
  const future = tl[3]!;
  assert.ok(future.degradation.reasons.includes("MISSING_PLAYER_PROJECTION"));
  assert.ok(["DEGRADED", "ROS_ONLY", "INSUFFICIENT"].includes(future.degradation.value));
});

/* ---------------- spec §29 adversarial ---------------- */

test("same-week QB + SUPER_FLEX bye with a single backup -> real uncovered exposure, no double count", () => {
  const sfPl = [
    player("qb1", "QB", { team: "KC" }), player("qb2", "QB", { team: "KC" }),
    player("rb1", "RB", { team: "DAL" }), player("rb2", "RB", { team: "BUF" }),
    player("wr1", "WR", { team: "SF" }), player("wr2", "WR", { team: "LV" }),
    player("te1", "TE", { team: "DAL" }), player("k1", "K", { team: "BUF" }), player("dst1", "DEF", { team: "SF" }),
  ];
  const inputs = { ...mkInputs(sfPl, { qb1: 22, qb2: 16, rb1: 14, rb2: 11, wr1: 13, wr2: 10, te1: 9, k1: 8, dst1: 7 }), constraints: SUPERFLEX_CONSTRAINTS };
  const r = roster("team:t", ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "qb2", "k1", "dst1"], [], { startingSlots: SUPERFLEX_CONSTRAINTS.starting_slots });
  const wk = buildWeekTimeline(mkTimelineInput({ inputs, roster: r, schedule: mkSchedule({ 6: ["KC"] }) })).find((w) => w.week === 6)!;
  // both KC QBs out; only one QB/SF-eligible body cannot fill two slots
  assert.equal(wk.bye_player_count, 2);
  assert.ok(wk.uncovered_slot_labels.length >= 1);
});

test("multiple RB byes same week -> FLEX collision reflected in coverage", () => {
  const wk = buildWeekTimeline(
    mkTimelineInput({
      inputs: mkInputs(PL, PTS),
      roster: std(STARTERS, ["qb2"]), // no spare RB/WR/TE for FLEX
      schedule: mkSchedule({ 11: ["KC", "DAL", "BUF"] }), // rb1, rb2, rb3 all out
    }),
  ).find((w) => w.week === 11)!;
  assert.ok(wk.bye_player_count >= 3);
  assert.ok(wk.uncovered_slot_labels.length >= 1);
  assert.equal(wk.legal_lineup_covered, false);
});

test("a versatile backup is never counted for two simultaneous future slots (spec §7, §29)", () => {
  // isolated roster: wr1 and wr2 are the ONLY players on their bye teams;
  // wr3 (bench) is the single legal filler for two vacated WR slots.
  const wrPl = [
    player("qb1", "QB", { team: "KC" }),
    player("rb1", "RB", { team: "DAL" }), player("rb2", "RB", { team: "BUF" }), player("rb3", "RB", { team: "NYG" }),
    player("wr1", "WR", { team: "SEA" }), player("wr2", "WR", { team: "MIA" }), player("wr3", "WR", { team: "CLE" }),
    player("te1", "TE", { team: "PHI" }), player("k1", "K", { team: "GB" }), player("dst1", "DEF", { team: "CHI" }),
  ];
  const pts = { qb1: 20, rb1: 14, rb2: 12, rb3: 9, wr1: 15, wr2: 13, wr3: 10, te1: 11, k1: 8, dst1: 7 };
  const wk = buildWeekTimeline(
    mkTimelineInput({
      inputs: mkInputs(wrPl, pts),
      roster: std(["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "dst1"], ["wr3"]),
      schedule: mkSchedule({ 9: ["SEA", "MIA"] }),
    }),
  ).find((w) => w.week === 9)!;
  assert.equal(wk.bye_player_count, 2);
  assert.equal(wk.uncovered_slot_labels.length, 1);
});

/* ---------------- spec §22 delta ---------------- */

function wrapPlan(tl: ReturnType<typeof buildWeekTimeline>): TeamSchedulePlan {
  return {
    planning_model_version: "schedule-planning-2026.1",
    lineage: {
      planning_model_version: "schedule-planning-2026.1",
      league_snapshot_id: "s1",
      weekly_projection_lineage: { model_version: "test", source: "test" },
      ros_projection_lineage: { source: "sleeper_season_rotowire_prorated", ri_model_version: "ri-test" },
    } as unknown as TeamSchedulePlan["lineage"],
    team_id: "team:t",
    roster_id: 1,
    manager_slug: "m",
    manager_display_name: "M",
    team_name: "T",
    is_vacant: false,
    week_timeline: tl,
    summary: { bye_concentration_window: null } as unknown as TeamSchedulePlan["summary"],
    degradation: { reasons: [], structure: "OK", value: "ROS_ONLY" },
    orchestrator_hint: null,
  };
}

test("delta: identical planning snapshots -> zero changes (spec §22, §30)", () => {
  const tl = buildWeekTimeline(
    mkTimelineInput({ inputs: mkInputs(PL, PTS), roster: std(STARTERS, BENCH), schedule: mkSchedule({ 7: ["KC"] }) }),
  );
  const d = planningDelta(wrapPlan(tl), wrapPlan(tl));
  assert.equal(d.changes.length, 0);
  assert.match(d.summary, /No change/);
});

test("delta: a new bye collision shows up as a descriptive change, never a verdict (spec §22)", () => {
  const before = wrapPlan(
    buildWeekTimeline(mkTimelineInput({ inputs: mkInputs(PL, PTS), roster: std(STARTERS, BENCH), schedule: mkSchedule({}) })),
  );
  const after = wrapPlan(
    buildWeekTimeline(mkTimelineInput({ inputs: mkInputs(PL, PTS), roster: std(STARTERS, BENCH), schedule: mkSchedule({ 8: ["KC", "DAL"] }) })),
  );
  const d = planningDelta(before, after);
  assert.ok(d.changes.some((c) => c.type === "BYE_COLLISION_ADDED"));
  assert.ok(!/good|bad|better|worse move|should/i.test(d.summary));
});

/* ---------------- spec §3, §26 isolation ---------------- */

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("lib/trades never imports schedule-planning (frozen, spec §3)", () => {
  for (const f of walk(join(ROOT, "lib", "trades"))) {
    assert.ok(!readFileSync(f, "utf8").includes("schedule-planning"), f);
  }
});

test("lib/trades/ros.ts and lib/weekly/lineup.ts are unchanged by Phase 7", () => {
  assert.ok(!readFileSync(join(ROOT, "lib", "trades", "ros.ts"), "utf8").includes("schedule-planning"));
  assert.ok(!readFileSync(join(ROOT, "lib", "weekly", "lineup.ts"), "utf8").includes("schedule-planning"));
});

test("schedule-planning never imports a recommendation engine (spec §26)", () => {
  for (const f of walk(join(ROOT, "lib", "schedule-planning"))) {
    const src = readFileSync(f, "utf8");
    for (const bad of ["@/lib/trades", "@/lib/weekly/waivers", "@/lib/weekly/start-sit", "start-sit-fi", "matchup-intelligence"]) {
      assert.ok(!src.includes(bad), `${f} imports ${bad}`);
    }
  }
});

test("schedule-planning reuses the frozen buildOptimalLineup + Phase 6 primitives, no new optimizer", () => {
  const ev = readFileSync(join(ROOT, "lib", "schedule-planning", "evaluate.ts"), "utf8");
  assert.ok(ev.includes("buildOptimalLineup"));
  assert.ok(ev.includes("evaluateHorizon"));
  assert.ok(!ev.includes("maxSlotMatching(") || ev.includes("@/lib/weekly")); // only via frozen modules
});
