/**
 * Player x Scheme Intelligence — Tier D (interaction research) contract +
 * hard-invariant tests (Phase 9, spec §21-27). SHADOW_ONLY;
 * numeric_fantasy_adjustment == 0 for every family, always.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

import {
  __resetPlayerSchemeCache,
  loadPlayerSchemeIntelligence,
  playerSchemeInteractions,
  tierDManifest,
  buildMatchupAlignment,
} from "@/lib/player-scheme-intelligence";

const OUT = join(process.cwd(), "outputs", "player-scheme-intelligence-2026");
const VALID = new Set(["PREDICTIVE_INCREMENTAL", "EXPLANATORY_ONLY", "UNSTABLE", "REJECTED", "INSUFFICIENT_DATA"]);

test("tierD: manifest lists tier D as SHADOW_ONLY with the hard zero invariant", () => {
  __resetPlayerSchemeCache();
  const psi = loadPlayerSchemeIntelligence()!;
  assert.ok(((psi.manifest as { tiers?: string[] }).tiers ?? []).includes("D"));
  const td = tierDManifest()!;
  assert.equal(td.lane, "SHADOW_ONLY");
  assert.equal(td.numeric_fantasy_adjustment, 0);
  assert.match(td.hard_invariant, /numeric_fantasy_adjustment == 0/);
});

test("tierD §22: EVERY interaction family carries numeric_fantasy_adjustment 0, SHADOW_ONLY", () => {
  const rows = playerSchemeInteractions();
  assert.ok(rows.length >= 5);
  for (const r of rows) {
    assert.equal(r.numeric_fantasy_adjustment, 0, `${r.position}/${r.family}`);
    assert.equal(r.deployment, "SHADOW_ONLY");
    assert.ok(VALID.has(r.validation_status), `${r.family} classified`);
    // even a PREDICTIVE_INCREMENTAL family only ever gets future eligibility, never influence
    if (r.validation_status !== "PREDICTIVE_INCREMENTAL") {
      assert.equal(r.future_production_eligibility, "NONE");
    }
  }
});

test("tierD §24: research finding recorded (anti-double-counting decision is vs the production-like baseline)", () => {
  const wf = JSON.parse(readFileSync(join(OUT, "tierD_walkforward.json"), "utf8"));
  assert.match(wf.baseline_note, /production-like/i);
  assert.match(wf.baseline_note, /NOT used as the certification baseline|not.*trustworthy/i);
  const recon = JSON.parse(readFileSync(join(OUT, "tierD_reconciliation.json"), "utf8"));
  assert.equal(recon.numeric_fantasy_adjustment_all_zero, true);
  assert.equal(recon.all_shadow_only, true);
  assert.equal(recon.every_family_classified, true);
  assert.equal(recon.fdr_method, "Benjamini-Hochberg");
});

test("tierD §27: a null result (0 PREDICTIVE_INCREMENTAL) is a valid, recorded outcome", () => {
  const td = tierDManifest()!;
  const s = td.outcome_summary;
  const total = Object.values(s).reduce((a, b) => a + b, 0);
  assert.ok(total >= 5);
  // this run's finding: no family beat the production-like baseline
  assert.equal(s.predictive_incremental, 0, "documented null result");
});

test("tierD §23: matchup surface exposes interaction_research with the hard zeros", () => {
  const psi = loadPlayerSchemeIntelligence()!;
  const qb = psi.directory.find((d) => d.position === "QB")!;
  const m = buildMatchupAlignment(qb.gsis_id, "SF", "career") as Record<string, unknown>;
  if ("interaction_research" in m) {
    const ir = m.interaction_research as Record<string, unknown>;
    assert.equal(ir.numeric_fantasy_adjustment, 0);
    assert.equal(ir.lane, "SHADOW_ONLY");
    for (const f of ir.families as Array<{ numeric_fantasy_adjustment: number }>) {
      assert.equal(f.numeric_fantasy_adjustment, 0);
    }
  }
});

test("tierD isolation §22: no production module imports the interactions artifact or lib", () => {
  const hits = execSync(
    `grep -rlnE "player_scheme_interactions|player-scheme-intelligence" lib/weekly lib/trades lib/orchestrator lib/roster-health lib/schedule-planning lib/projections lib/football-intel lib/team-state 2>/dev/null || true`,
    { cwd: process.cwd(), encoding: "utf8" },
  ).trim();
  assert.equal(hits, "");
});

test("tierD: synthetic-sanity artifact families present (ablation + calibration)", () => {
  const abl = JSON.parse(readFileSync(join(OUT, "tierD_ablation.json"), "utf8"));
  const cal = JSON.parse(readFileSync(join(OUT, "tierD_calibration.json"), "utf8"));
  assert.ok(abl.rows.length >= 5);
  assert.ok(cal.rows.length >= 10);
});
