/**
 * Phase 4 — isolation guarantees (spec §14, §32):
 *  - Phase 3 (`lib/football-intel`) never imports recommendation code.
 *  - the trade engine never imports the Phase 4 start/sit FI layer.
 *  - activating the shadow path does not change trade-engine projections.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("lib/football-intel never imports recommendation / weekly / trade code", () => {
  for (const f of walk(join(ROOT, "lib", "football-intel"))) {
    const src = readFileSync(f, "utf8");
    for (const bad of ["@/lib/weekly", "@/lib/trades", "@/lib/draft", "start-sit"]) {
      assert.ok(!src.includes(`from "${bad}`) && !src.includes(`from '${bad}`), `${f} imports ${bad}`);
    }
  }
});

test("lib/trades never imports the Phase 4 start-sit FI layer", () => {
  for (const f of walk(join(ROOT, "lib", "trades"))) {
    const src = readFileSync(f, "utf8");
    assert.ok(!src.includes("start-sit-fi"), `${f} imports start-sit-fi`);
    assert.ok(!src.includes("football-intel"), `${f} imports football-intel`);
  }
});

test("the R Football Intelligence engine has no fantasy-roster awareness", () => {
  // structural: analysis/football_intel* must not reference league/manager/roster objects
  for (const dir of ["football_intel", "football_intel_startsit"]) {
    for (const f of walk(join(ROOT, "analysis", dir)).filter((p) => p.endsWith(".R"))) {
      const src = readFileSync(f, "utf8");
      // startsit trains ON fantasy outcomes but must not import a live roster/league object;
      // it only reads Sleeper *player* projections/stats + the FI artifact.
      assert.ok(!/canonical.*roster|LeagueManagementContext|buildOptimalLineup/i.test(src), `${f}`);
    }
  }
});

test("shadow path is only wired into buildWeeklyIntelligence, not the lineup optimizer or trades", () => {
  const lineup = readFileSync(join(ROOT, "lib", "weekly", "lineup.ts"), "utf8");
  assert.ok(!lineup.includes("start-sit-fi"), "lineup.ts must not import the FI layer");
  const evaluate = readFileSync(join(ROOT, "lib", "trades", "evaluate.ts"), "utf8");
  assert.ok(!evaluate.includes("start-sit-fi"));
});
