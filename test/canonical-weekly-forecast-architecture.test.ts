/**
 * W1.P1 architecture guards.
 *  1. ONE construction path: nothing outside lib/weekly/forecast/ builds a CanonicalWeeklyPlayerForecast.
 *  2. RATCHET: the set of files that read legacy per-player weekly projection fields straight off a projection batch is
 *     frozen at the W1.P1 inventory. A NEW direct reader fails this test: new decision code must consume
 *     `ctx.forecasts` (CanonicalWeeklyPlayerForecast) instead of independently choosing a projection. Removing a file from
 *     the list (migrating it) is always allowed and is how the legacy set retires.
 *  3. Forecast code is read-only/pure: no I/O, wall clock or randomness.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const rel = (f: string) => relative(ROOT, f).replaceAll("\\", "/");
const files = ["lib", "app"].flatMap((b) => walk(join(ROOT, b)));

test("W1.P1: only lib/weekly/forecast/ constructs canonical forecasts", () => {
  const violations = files
    .map((f) => ({ f: rel(f), src: readFileSync(f, "utf8") }))
    .filter(({ f }) => !f.startsWith("lib/weekly/forecast/"))
    .filter(({ src }) => /CANONICAL_WEEKLY_FORECAST_VERSION|buildCanonicalWeeklyPlayerForecast\s*\(/.test(src))
    .map(({ f }) => f);
  assert.deepEqual(violations, []);
});

test("W1.P1: the weekly context attaches forecasts through the one batch builder", () => {
  const src = readFileSync(join(ROOT, "lib/weekly/context.ts"), "utf8");
  assert.equal((src.match(/buildCanonicalForecastBatch\(/g) ?? []).length, 1);
  assert.match(src, /forecasts,\n/);
});

/** Legacy direct readers. W1.P1: 29 files. W1.P2: 28 (lib/weekly/lineup.ts now reads values only via forecast/view.ts). Must only ever shrink.
 *  Original description: each reads `projected_points` / `expected_availability` / `projection_status` / `is_bye` via a projection batch. */
const LEGACY_DIRECT_READERS = [
  "lib/draft/engine.ts",
  "lib/persistence/supabase/matchup2-capture.ts",
  "lib/roster-health/contingency.ts",
  "lib/roster-health/evaluate.ts",
  "lib/roster-health/inputs.ts",
  "lib/schedule-planning/evaluate.ts",
  "lib/trades/competitive/horizon.ts",
  "lib/trades/competitive/owner-context.ts",
  "lib/trades/competitive/private-value.ts",
  "lib/trades/competitive/readiness.ts",
  "lib/trades/competitive/threat.ts",
  "lib/trades/depth.ts",
  "lib/trades/discovery/bilateral.ts",
  "lib/trades/discovery/counteroffer.ts",
  "lib/trades/discovery/profiles.ts",
  "lib/trades/discovery/three-team.ts",
  "lib/trades/evaluate.ts",
  "lib/trades/intelligence.ts",
  "lib/trades/ros.ts",
  "lib/waiver2/context.ts",
  "lib/weekly/context.ts",
  "lib/weekly/intelligence.ts",
  "lib/weekly/matchup-intelligence/build.ts",
  "lib/weekly/matchup.ts",
  "lib/weekly/replacement.ts",
  "lib/weekly/start-sit-fi/production-gate.ts",
  "lib/weekly/start-sit-fi/shadow.ts",
  "lib/weekly/waivers.ts",
];

test("W1.P1 ratchet: no NEW file reads legacy weekly projection fields directly off a projection batch", () => {
  const allowed = new Set(LEGACY_DIRECT_READERS);
  const reads = /(projections|weekly|batch)\.by_player|by_player\.get/;
  const fields = /projected_points|expected_availability|projection_status|is_bye/;
  const found = files
    .map((f) => ({ f: rel(f), src: readFileSync(f, "utf8") }))
    .filter(({ f }) => !f.startsWith("lib/weekly/forecast/") && !f.startsWith("lib/weekly/projections/"))
    .filter(({ src }) => reads.test(src) && fields.test(src))
    .map(({ f }) => f)
    .sort();
  const added = found.filter((f) => !allowed.has(f));
  assert.deepEqual(added, [], `new direct projection reader(s) — consume ctx.forecasts (CanonicalWeeklyPlayerForecast) instead: ${added.join(", ")}`);
});

test("W1.P1: forecast modules are pure (no I/O, clock, randomness, or provider imports)", () => {
  for (const f of readdirSync(join(ROOT, "lib/weekly/forecast")).filter((n) => n.endsWith(".ts"))) {
    const src = readFileSync(join(ROOT, "lib/weekly/forecast", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.equal(/Date\.now|new Date\(|Math\.random|fetch\(|process\.env|from "node:fs"/.test(src), false, `${f} must stay pure`);
    assert.equal(/lib\/sleeper|lib\/providers|persistence/.test(src), false, `${f} must stay provider-neutral`);
  }
});

test("W1.P2 ratchet: the legacy-reader count only goes down (29 at W1.P1 -> 28 at W1.P2)", () => {
  assert.equal(LEGACY_DIRECT_READERS.length, 28);
  assert.equal(LEGACY_DIRECT_READERS.includes("lib/weekly/lineup.ts"), false);
});

test("W1.P2: the lineup optimizer reads per-player values only through the canonical decision view", () => {
  const src = readFileSync(join(ROOT, "lib/weekly/lineup.ts"), "utf8");
  assert.equal(/\.by_player/.test(src), false, "lineup.ts must not read projection rows directly");
  assert.match(src, /decisionProjectionRows\(projections, input\.forecasts\)/);
});

test("W1.P2: only the injury model computes injury discounts (no other module multiplies a projection by an availability)", () => {
  const offenders = files
    .map((f) => ({ f: rel(f), src: readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "") }))
    .filter(({ f }) => !f.endsWith("lib/weekly/forecast/injury-model.ts"))
    .filter(({ src }) => /projected_points\s*\*\s*[\w.?]*(expected_availability|probability_active)|\b(expected_availability|probability_active)\s*\*\s*[\w.?]*projected_points/.test(src))
    .map(({ f }) => f);
  assert.deepEqual(offenders, []);
});

test("W1.P2: lineup and matchup (the migrated consumers) are the only production callers passing forecasts to the optimizer", () => {
  const callers = files
    .map((f) => ({ f: rel(f), src: readFileSync(f, "utf8") }))
    .filter(({ f }) => f.startsWith("lib/") && /forecasts:\s*ctx\.forecasts/.test(readFileSync(join(ROOT, f), "utf8")))
    .map(({ f }) => f)
    .sort();
  assert.deepEqual(callers, ["lib/weekly/intelligence.ts", "lib/weekly/matchup.ts"]);
});

/**
 * W1.P3 bye-semantics ratchet. Before W1.P3, independent bye logic lived in 9 files (8 predicate sites + 3 zero producers). Now there is
 * ONE canonical module (lib/weekly/forecast/bye.ts) and exactly two sanctioned exceptions, both documented. A new independent bye
 * predicate or bye-zero producer fails here: ask `isVerifiedBye` / build the row with `verifiedByeRow` instead.
 */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const BYE_PREDICATE = /projection_status\s*[!=]==?\s*"bye"/;
const BYE_ZERO_PRODUCER = /projection_status:\s*"bye"|onBye\s*\?\s*0\s*:/;

test("W1.P3 ratchet: independent bye PREDICATES — only the canonical helper and documented exceptions", () => {
  const ALLOWED = new Set([
    "lib/waiver2/roster.ts", // Waiver Intelligence 2.0 is SHADOW_ONLY and deliberately untouched in W1.P3 (same semantics; documented)
  ]);
  const found = files
    .map((f) => ({ f: rel(f), src: stripComments(readFileSync(f, "utf8")) }))
    .filter(({ f }) => !f.startsWith("lib/weekly/forecast/"))
    .filter(({ src }) => BYE_PREDICATE.test(src))
    .map(({ f }) => f)
    .filter((f) => !ALLOWED.has(f));
  assert.deepEqual(found, [], `new independent bye predicate(s) — use isVerifiedBye(): ${found.join(", ")}`);
});

test("W1.P3 ratchet: independent bye-ZERO producers — the verified-bye row is built in one place", () => {
  const ALLOWED = new Set([
    // per-FUTURE-WEEK utility basis for schedule planning: a bye is legitimately 0 for THAT week's lineup; it is not an asset value
    "lib/schedule-planning/evaluate.ts",
  ]);
  const found = files
    .map((f) => ({ f: rel(f), src: stripComments(readFileSync(f, "utf8")) }))
    .filter(({ f }) => !f.startsWith("lib/weekly/forecast/"))
    .filter(({ src }) => BYE_ZERO_PRODUCER.test(src))
    .map(({ f }) => f)
    .filter((f) => !ALLOWED.has(f));
  assert.deepEqual(found, [], `new independent bye-zero producer(s) — use verifiedByeRow(): ${found.join(", ")}`);
});

test("W1.P3: the two production bye-row builders (context, trade ROS) both go through verifiedByeRow", () => {
  for (const f of ["lib/weekly/context.ts", "lib/trades/ros.ts"]) {
    assert.match(readFileSync(join(ROOT, f), "utf8"), /verifiedByeRow\(/, f);
  }
});

test("W1.P3: legacy direct-reader count did not increase (28 at W1.P2, 28 at W1.P3)", () => {
  assert.ok(LEGACY_DIRECT_READERS.length <= 28);
});
