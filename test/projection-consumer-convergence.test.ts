import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

test("Phase 6: roster-health inputs can reuse an already-certified snapshot", () => {
  const src = read("lib", "roster-health", "inputs.ts");
  assert.match(src, /snapshotOverride\?: CanonicalLeagueSnapshot/);
  assert.match(src, /options\.snapshotOverride\s*\?/);
  assert.match(src, /snapshot: options\.snapshotOverride/);
});

test("Phase 6: standalone specialists retain independent builds when no inputs are injected", () => {
  const roster = read("lib", "roster-health", "build.ts");
  const planning = read("lib", "schedule-planning", "build.ts");

  assert.match(roster, /inputsOverride\?: RosterHealthInputs/);
  assert.match(roster, /options\.inputsOverride \?\? await buildRosterHealthInputs\(leagueSlug, options\)/);

  assert.match(planning, /inputsOverride\?: RosterHealthInputs/);
  assert.match(planning, /options\.inputsOverride \?\? await buildRosterHealthInputs\(leagueSlug, options\)/);
});

test("Phase 6: orchestrator builds one shared projection-input package for roster health and schedule planning", () => {
  const src = read("lib", "orchestrator", "context.ts");
  const calls = src.match(/buildRosterHealthInputs\(/g) ?? [];
  assert.equal(calls.length, 1, "composite orchestrator must prepare shared roster-health inputs exactly once");

  const injections = src.match(/inputsOverride: sharedRosterInputs/g) ?? [];
  assert.equal(injections.length, 2, "the same shared package must feed both context-only specialists");

  assert.match(src, /roster_health_input_builds: number/);
  assert.match(src, /roster_health_inputs_shared: boolean/);
  assert.match(src, /metrics\.roster_health_inputs_shared = true/);
});

test("Phase 6: production trace exposes whether shared-input convergence occurred", () => {
  const src = read("lib", "orchestrator", "trace.ts");
  assert.match(src, /roster_health_input_builds: number/);
  assert.match(src, /roster_health_inputs_shared: boolean/);
  assert.match(src, /roster_health_input_builds: mac\.metrics\.roster_health_input_builds/);
  assert.match(src, /roster_health_inputs_shared: mac\.metrics\.roster_health_inputs_shared/);
});
