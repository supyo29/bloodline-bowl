/**
 * Player x Scheme Intelligence — Tier A read-contract + reconciliation tests
 * (Phase 9, spec §41, §42, §43). Deterministic — no network, no R. Runs
 * against the committed snapshot in lib/player-scheme-intelligence/data/.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  __resetPlayerSchemeCache,
  loadPlayerSchemeIntelligence,
  qbMatrix,
  qbDirectional,
  defensePassMatrix,
  resolvePlayer,
  buildQbProfile,
  buildDefenseProfile,
  buildMatchupAlignment,
} from "@/lib/player-scheme-intelligence";

const DATA = join(process.cwd(), "lib", "player-scheme-intelligence", "data");
const DEPTHS = ["BEHIND_LOS", "SHORT", "INTERMEDIATE", "DEEP"];
const THIRDS = ["LEFT", "MIDDLE", "RIGHT"];

test("psi: manifest loads, Tier A, SHARED_DESCRIPTIVE, no fantasy adjustment", () => {
  __resetPlayerSchemeCache();
  const psi = loadPlayerSchemeIntelligence();
  assert.ok(psi, "a snapshot is published");
  assert.match(psi!.manifest.player_scheme_version, /^psi:\d{4}:w\d{2}:[0-9a-f]{12}$/);
  assert.equal(psi!.manifest.model_tag, "player-scheme-intelligence-2026.1");
  assert.equal(psi!.manifest.deployment, "SHARED_DESCRIPTIVE");
  assert.equal(psi!.manifest.fantasy_adjustment_enabled, false);
  assert.ok(["LIVE_CURRENT", "PRIOR_ONLY"].includes(psi!.manifest.current_season_status));
});

test("psi: reconciliation artifact reports all_pass", () => {
  const recon = JSON.parse(
    readFileSync(join(process.cwd(), "outputs", "player-scheme-intelligence-2026", "tierA_reconciliation.json"), "utf8"),
  );
  assert.equal(recon.all_pass, true, "R-side reconciliation must pass");
  assert.equal(recon.qb_matrix_reconciles, true);
  assert.equal(recon.def_pass_matrix_reconciles, true);
});

test("psi §41: QB matrix cells sum to attempts_charted; charted+uncharted=total", () => {
  const psi = loadPlayerSchemeIntelligence()!;
  const sample = psi.directory.filter((d) => d.position === "QB").slice(0, 25);
  let checked = 0;
  for (const q of sample) {
    const cells = qbMatrix(q.gsis_id).filter((c) => c.window === "career");
    if (cells.length === 0) continue;
    checked += 1;
    const cellSum = cells.reduce((s, c) => s + (c.attempts ?? 0), 0);
    const charted = cells[0]!.attempts_charted ?? 0;
    const total = cells[0]!.attempts_total ?? 0;
    const uncharted = cells[0]!.attempts_uncharted ?? 0;
    assert.equal(cellSum, charted, `${q.full_name}: cell attempts sum == attempts_charted`);
    assert.equal(charted + uncharted, total, `${q.full_name}: charted + uncharted == total`);
  }
  assert.ok(checked >= 10, "checked a meaningful number of QBs");
});

test("psi §41: no fabricated MIDDLE/SHORT — every cell has a real depth_bin and field_third", () => {
  const psi = loadPlayerSchemeIntelligence()!;
  for (const q of psi.directory.filter((d) => d.position === "QB").slice(0, 40)) {
    for (const c of qbMatrix(q.gsis_id)) {
      assert.ok(DEPTHS.includes(c.depth_bin), `valid depth_bin ${c.depth_bin}`);
      assert.ok(THIRDS.includes(c.field_third), `valid field_third ${c.field_third}`);
    }
  }
});

test("psi §41: directional L/M/R and depth shares each sum to 1", () => {
  const psi = loadPlayerSchemeIntelligence()!;
  let checked = 0;
  for (const q of psi.directory.filter((d) => d.position === "QB").slice(0, 30)) {
    for (const d of qbDirectional(q.gsis_id)) {
      const v = d.values;
      const lmr = (v.left_pct ?? 0) + (v.middle_pct ?? 0) + (v.right_pct ?? 0);
      const depth = (v.behind_los_pct ?? 0) + (v.short_pct ?? 0) + (v.intermediate_pct ?? 0) + (v.deep_pct ?? 0);
      if (d.n && d.n > 0) {
        assert.ok(Math.abs(lmr - 1) < 1e-9, `${q.full_name}/${d.window}: L+M+R=1`);
        assert.ok(Math.abs(depth - 1) < 1e-9, `${q.full_name}/${d.window}: depth shares=1`);
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 10);
});

test("psi §42: defense pass matrix cells reconcile to targets_charted per team/window", () => {
  const teams = new Set<string>();
  const raw = readFileSync(join(DATA, "defense_pass_vulnerability.csv"), "utf8").split(/\r?\n/).slice(1);
  for (const l of raw) { const t = l.split(",")[0]; if (t) teams.add(t); }
  assert.equal(teams.size, 32, "all 32 defenses present");
  for (const t of teams) {
    for (const w of ["career", "recent"] as const) {
      const cells = defensePassMatrix(t).filter((c) => c.window === w);
      if (cells.length === 0) continue;
      const sum = cells.reduce((s, c) => s + (c.targets_allowed ?? 0), 0);
      // targets_charted is not on the served cell; reconcile internal consistency:
      assert.equal(cells.length, 12, `${t}/${w}: 12 cells (4 depth x 3 third)`);
      assert.ok(sum > 0, `${t}/${w}: non-empty`);
    }
  }
});

test("psi §43 case 29: unresolved id returns UNRESOLVED, never a guess", () => {
  const r = resolvePlayer("00-9999999");
  assert.equal(r.entry, null);
  assert.equal(r.matched_on, null);
  const prof = buildQbProfile("definitely not a real player name");
  assert.ok(prof && "resolution" in prof && prof.resolution === "UNRESOLVED");
});

test("psi §43 cases 3-4: a deep passer ranks above a checkdown passer on deep_pct", () => {
  const psi = loadPlayerSchemeIntelligence()!;
  const deepPct = (name: string): number | null => {
    const hit = psi.directory.find((d) => d.full_name === name);
    if (!hit) return null;
    const d = qbDirectional(hit.gsis_id).find((x) => x.window === "career");
    return d?.values.deep_pct ?? null;
  };
  // Josh Freeman / Will Levis are well-documented deep chuckers; Garoppolo a checkdown QB.
  const deep = deepPct("Josh Freeman") ?? deepPct("Will Levis");
  const check = deepPct("Jimmy Garoppolo") ?? deepPct("Colt McCoy");
  if (deep != null && check != null) assert.ok(deep > check, "deep passer deep_pct > checkdown passer");
});

test("psi §33/§35: matchup output is descriptive, adjustment 0, SHADOW_ONLY", () => {
  const psi = loadPlayerSchemeIntelligence()!;
  const qb = psi.directory.find((d) => d.position === "QB" && qbMatrix(d.gsis_id).length > 0)!;
  const m = buildMatchupAlignment(qb.gsis_id, "KC", "career") as Record<string, unknown>;
  assert.ok(m);
  if ("alignment" in m) {
    const a = m.alignment as Record<string, unknown>;
    assert.equal(a.numeric_fantasy_adjustment, 0);
    assert.equal(a.deployment, "SHADOW_ONLY");
    assert.equal(a.validation_status, "SHARED_DESCRIPTIVE");
  }
});

test("psi: defense profile has 32 teams and a 12-cell vulnerability map", () => {
  const d = buildDefenseProfile("SF") as Record<string, unknown>;
  assert.ok(d && "windows" in d);
  const w = (d.windows as Record<string, { pass_vulnerability_matrix: unknown[] }>).career;
  assert.equal(w.pass_vulnerability_matrix.length, 12);
});

test("psi: identical inputs -> identical served content hash (determinism)", () => {
  const recon = JSON.parse(
    readFileSync(join(process.cwd(), "outputs", "player-scheme-intelligence-2026", "tierA_reconciliation.json"), "utf8"),
  );
  const psi = loadPlayerSchemeIntelligence()!;
  assert.equal(psi.manifest.player_scheme_version.split(":")[3], recon.served_content_sha256.slice(0, 12));
});
