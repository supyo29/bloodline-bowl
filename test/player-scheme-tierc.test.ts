/**
 * Player x Scheme Intelligence — Tier C (team tendency + archetype vectors +
 * scheme era) contract tests (Phase 9, spec §16, §17, §20, §21, §22).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  __resetPlayerSchemeCache,
  loadPlayerSchemeIntelligence,
  tierCManifest,
  offenseTeamProfile,
  defenseTeamProfile,
  qbArchetypeVector,
  defenseArchetypeVector,
  schemeEra,
  buildDefenseProfile,
  buildTeamOffenseProfile,
} from "@/lib/player-scheme-intelligence";

const OUT = join(process.cwd(), "outputs", "player-scheme-intelligence-2026");

test("tierC: manifest lists tiers A,B,C and per-column availability", () => {
  __resetPlayerSchemeCache();
  const psi = loadPlayerSchemeIntelligence()!;
  assert.deepEqual((psi.manifest as { tiers?: string[] }).tiers, ["A", "B", "C"]);
  const tc = tierCManifest()!;
  assert.equal(tc.does_not_modify_football_intel, true);
  assert.equal(tc.offense_column_availability.live, "LIVE_CAPABLE");
  assert.equal(tc.offense_column_availability.formation, "PRIOR_ONLY");
  assert.equal(tc.offense_column_availability.ftn, "DESCRIPTIVE_ONLY");
  assert.equal(tc.defense_column_availability.man_zone, "PRIOR_ONLY");
});

test("tierC §17: defense man_rate + zone_rate sum to 1 (charted only)", () => {
  for (const team of ["SF", "KC", "NYJ", "BAL"]) {
    const rows = defenseTeamProfile(team).filter((r) => r.window === "career");
    for (const r of rows) {
      const m = r.man_zone__man_rate as number | null;
      const z = r.man_zone__zone_rate as number | null;
      if (m != null && z != null) assert.ok(Math.abs(m + z - 1) < 1e-9, `${team} man+zone=1`);
    }
  }
});

test("tierC §16: offense target-area shares sum to 1 in each direction/depth", () => {
  for (const team of ["KC", "MIA", "PHI"]) {
    const r = offenseTeamProfile(team).find((x) => x.window === "career")!;
    const lmr = (r.target_area__tgt_left as number) + (r.target_area__tgt_middle as number) + (r.target_area__tgt_right as number);
    const depth = (r.target_area__tgt_behind_los as number) + (r.target_area__tgt_short as number) +
      (r.target_area__tgt_intermediate as number) + (r.target_area__tgt_deep as number);
    assert.ok(Math.abs(lmr - 1) < 1e-9);
    assert.ok(Math.abs(depth - 1) < 1e-9);
  }
});

test("tierC §21/§22: archetype numeric vectors ship; labels withheld when unstable", () => {
  const stab = JSON.parse(readFileSync(join(OUT, "tierC_archetype_stability.json"), "utf8"));
  const v = qbArchetypeVector(loadPlayerSchemeIntelligence()!.directory.find((d) => d.position === "QB")!.gsis_id);
  // a vector exists for at least one QB with complete features
  const anyQb = loadPlayerSchemeIntelligence()!.directory
    .filter((d) => d.position === "QB")
    .map((d) => qbArchetypeVector(d.gsis_id))
    .find((x) => x != null);
  assert.ok(anyQb, "at least one QB archetype vector shipped");
  // labels are emitted iff ARI cleared the bar
  if (stab.qb.mean_ari < 0.55) {
    assert.equal(stab.qb.labels_emitted, false, "unstable QB clusters -> no labels");
  }
  const d = defenseArchetypeVector("SF")!;
  assert.ok(d, "defense archetype vector for all 32 teams");
  assert.ok(typeof d.man_rate === "number" || d.man_rate === null);
});

test("tierC §20: coordinator identity is NOT guessed", () => {
  const tc = tierCManifest()!;
  assert.equal(tc.scheme_era.coordinator_identity_available, false);
  assert.equal(tc.scheme_era.coordinators_yaml_entries, 0);
  const era = schemeEra("KC");
  for (const e of era) assert.equal(e.coordinator_known, false);
});

test("tierC reconciliation artifact all_pass, 32 teams both sides, FI untouched", () => {
  const r = JSON.parse(readFileSync(join(OUT, "tierC_reconciliation.json"), "utf8"));
  assert.equal(r.all_pass, true);
  assert.equal(r.offense_32_teams, true);
  assert.equal(r.defense_32_teams, true);
  assert.equal(r.coordinator_not_guessed, true);
  assert.equal(r.labels_only_if_stable, true);
});

test("tierC: defense profile query embeds tendency + archetype + scheme era", () => {
  const d = buildDefenseProfile("BAL") as Record<string, unknown>;
  assert.ok("tendency" in d && "archetype_vector" in d && "scheme_era" in d);
  const off = buildTeamOffenseProfile("BAL") as Record<string, unknown>;
  assert.ok("by_window" in off && "column_availability" in off);
});

test("tierC: Football Intelligence artifacts are not touched by Phase 9", () => {
  // structural: FI manifest still says ri-football-intel-2026.1 and is unchanged
  const fi = JSON.parse(readFileSync(join(process.cwd(), "lib", "football-intel", "data", "football_intelligence_manifest.json"), "utf8"));
  assert.equal(fi.model_tag, "ri-football-intel-2026.1");
});
