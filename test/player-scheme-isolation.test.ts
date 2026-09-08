/**
 * Player x Scheme Intelligence — Phase 1-8 isolation (spec §1, §44).
 *
 * Phase 9 is ADDITIVE. No frozen production module may import it, and the
 * Phase 9 lib must not import any production recommendation engine (which
 * would risk a cycle / accidental wiring).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

const PROD_DIRS = [
  "lib/weekly",
  "lib/trades",
  "lib/roster-health",
  "lib/schedule-planning",
  "lib/orchestrator",
  "lib/team-state",
  "lib/canonical",
  "lib/projections",
  "lib/football-intel",
];

test("no production module imports lib/player-scheme-intelligence", () => {
  for (const dir of PROD_DIRS) {
    let hits = "";
    try {
      hits = execSync(
        `grep -rn "player-scheme-intelligence" ${dir} || true`,
        { cwd: process.cwd(), encoding: "utf8" },
      );
    } catch { /* grep exit 1 = no match */ }
    assert.equal(hits.trim(), "", `${dir} must not reference Phase 9:\n${hits}`);
  }
});

test("Phase 9 lib does not import a production recommendation engine", () => {
  const hits = execSync(
    `grep -rnE "@/lib/(weekly|trades|roster-health|schedule-planning|orchestrator|projections)" lib/player-scheme-intelligence || true`,
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(hits.trim(), "", `Phase 9 lib must stay self-contained:\n${hits}`);
});

test("the only app route touching Phase 9 is app/api/player-scheme/*", () => {
  const hits = execSync(
    `grep -rln "player-scheme-intelligence" app || true`,
    { cwd: process.cwd(), encoding: "utf8" },
  ).trim().split("\n").filter(Boolean);
  for (const f of hits) {
    assert.ok(f.startsWith("app/api/player-scheme/"), `unexpected consumer: ${f}`);
  }
});
