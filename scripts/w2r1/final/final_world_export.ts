/** S7 FINAL: exports the 2026 wk1-5 W2.P1-style world (B0p, designation, B1p, frozen C2) to scripts/w2r1/cache/p1_world_2026f.csv. Frozen models are READ, never refit. */
import { readFileSync, writeFileSync } from "node:fs";
import { b1Of, c2Of, type RidgeModel } from "../../lib/role-qualification";
import { buildFinalWorld } from "./generated/final_world";
const fz = JSON.parse(readFileSync("scripts/w2p1/FROZEN.json", "utf8")) as { models: Record<string, RidgeModel | null> };
const world = buildFinalWorld();
const head = ["gsis", "season", "week", "team", "position", "designation", "raw_status", "practice", "played", "covered", "conf", "b0", "actual", "b1", "c2_expected", "c2_delta", "c2_capped", "c2_applicable"];
const lines = [head.join(",")];
for (const r of world.rows) { const m = fz.models[`C2|${r.position}|HALF`] ?? null; const c = c2Of(r, m, "HALF");
  lines.push([r.gsis, 2026, r.week, r.team, r.position, r.designation, r.raw_status ?? "", r.practice ?? "", r.played ? 1 : 0, r.covered ? 1 : 0, r.conf, r.b0.HALF, r.actual.HALF, b1Of(r, "HALF"), c.expected, c.delta, c.capped ? 1 : 0, c.applicable ? 1 : 0].join(",")); }
writeFileSync("scripts/w2r1/cache/p1_world_2026f.csv", lines.join("\n") + "\n");
console.log("rows", world.rows.length, "pit_violations", world.pointInTimeViolations.length, JSON.stringify(world.counts));
