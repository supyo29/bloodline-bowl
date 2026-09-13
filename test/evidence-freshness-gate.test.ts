import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const gate = path.join(process.cwd(), "scripts", "evidence-freshness-gate.mjs");

type Fixture = {
  audit: Record<string, unknown>;
  fi: Record<string, unknown>;
  psi: Record<string, unknown>;
  before?: Record<string, unknown> | null;
};

function priorOnlyFixture(): Fixture {
  return {
    audit: {
      current_season: 2026,
      as_of_note:
        "As of generation, 0 rows of any of the 3 audited sources are cached for season 2026; every cached source's newest data is a prior season. Every Phase 9 calculation is PRIOR_ONLY for 2026 until 2026 games are played and ingested.",
      sources: {
        pbp: {
          current_season_rows: 0,
          last_available: "2025-w18",
          availability_state: "HISTORICAL_CURRENT_THROUGH_2025",
          live_class: "LIVE_CAPABLE",
        },
        participation: {
          current_season_rows: 0,
          last_available: "2025-w18",
          availability_state: "HISTORICAL_CURRENT_THROUGH_2025",
          live_class: "PRIOR_ONLY_CURRENT_SEASON",
        },
        ftn_charting: {
          current_season_rows: 0,
          last_available: "2025-w22",
          availability_state: "HISTORICAL_CURRENT_THROUGH_2025",
          live_class: "PRIOR_ONLY_CURRENT_SEASON",
        },
      },
    },
    fi: {
      season: 2025,
      through_week: 18,
    },
    psi: {
      current_season: 2025,
      as_of_week: 18,
      availability_state: "HISTORICAL_CURRENT_THROUGH_2025",
      current_season_status: "PRIOR_ONLY",
      fantasy_adjustment_enabled: false,
      tier_b: {
        current_season_observed: { participation: false, ftn: false },
        families: [
          { source: "participation", current_season_observed: false, availability: "PRIOR_ONLY" },
          { source: "ftn", current_season_observed: false, availability: "DESCRIPTIVE_ONLY" },
        ],
      },
      tier_d: {
        lane: "SHADOW_ONLY",
        numeric_fantasy_adjustment: 0,
      },
    },
  };
}

function currentPbpFixture(): Fixture {
  const fixture = priorOnlyFixture();
  const sources = (fixture.audit.sources as Record<string, Record<string, unknown>>);
  sources.pbp = {
    current_season_rows: 1450,
    last_available: "2026-w1",
    availability_state: "LIVE_CURRENT",
    live_class: "LIVE_CAPABLE",
  };
  (fixture.audit as Record<string, unknown>).as_of_note =
    "As of generation, 1 of 3 audited sources carry season 2026 rows: pbp (1450 rows through 2026-w1). 2 source(s) still have no season 2026 rows and remain PRIOR_ONLY: ftn_charting, participation. A source without season 2026 rows is PRIOR_ONLY regardless of the calendar date; only each source's own current_season_rows / availability_state is authoritative.";
  fixture.fi = { season: 2026, through_week: 1 };
  fixture.psi = {
    ...fixture.psi,
    current_season: 2026,
    as_of_week: 1,
    availability_state: "LIVE_CURRENT",
    current_season_status: "LIVE_CURRENT",
  };
  return fixture;
}

function runGate(fixture: Fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bloodline-evidence-gate-"));
  const auditPath = path.join(dir, "audit.json");
  const fiPath = path.join(dir, "fi.json");
  const psiPath = path.join(dir, "psi.json");
  const beforePath = path.join(dir, "before.json");
  const outPath = path.join(dir, "out.json");
  fs.writeFileSync(auditPath, JSON.stringify(fixture.audit));
  fs.writeFileSync(fiPath, JSON.stringify(fixture.fi));
  fs.writeFileSync(psiPath, JSON.stringify(fixture.psi));
  if (fixture.before) fs.writeFileSync(beforePath, JSON.stringify(fixture.before));

  const args = [gate, "--audit", auditPath, "--fi", fiPath, "--psi", psiPath, "--out", outPath];
  if (fixture.before) args.push("--before", beforePath);
  const child = spawnSync(process.execPath, args, { encoding: "utf8" });
  const result = JSON.parse(fs.readFileSync(outPath, "utf8")) as {
    status: string;
    change_class: string;
    failures: Array<{ code: string; detail: string }>;
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return { child, result };
}

test("freshness gate accepts a coherent prior-only 2026 preseason state", () => {
  const { child, result } = runGate(priorOnlyFixture());
  assert.equal(child.status, 0, child.stderr);
  assert.equal(result.status, "PASS");
  assert.equal(result.change_class, "BASELINE_UNAVAILABLE");
});

test("freshness gate accepts live 2026 PBP while lagging charting remains prior-only", () => {
  const { child, result } = runGate(currentPbpFixture());
  assert.equal(child.status, 0, child.stderr);
  assert.equal(result.status, "PASS");
});

test("freshness gate rejects a PSI manifest that claims LIVE_CURRENT with zero 2026 PBP rows", () => {
  const fixture = priorOnlyFixture();
  fixture.psi = {
    ...fixture.psi,
    current_season: 2026,
    as_of_week: 1,
    availability_state: "LIVE_CURRENT",
    current_season_status: "LIVE_CURRENT",
  };
  const { child, result } = runGate(fixture);
  assert.equal(child.status, 2);
  assert.equal(result.status, "FAIL");
  assert.ok(result.failures.some((failure) => failure.code === "PSI_DOES_NOT_FAKE_CURRENT_WITHOUT_PBP"));
});

test("freshness gate rejects a source cutoff regression", () => {
  const fixture = currentPbpFixture();
  fixture.before = {
    current_season: 2026,
    sources: {
      pbp: {
        current_season_rows: 3000,
        last_available: "2026-w2",
        availability_state: "LIVE_CURRENT",
      },
    },
  };
  const { child, result } = runGate(fixture);
  assert.equal(child.status, 2);
  assert.ok(result.failures.some((failure) => failure.code === "SOURCE_pbp_NO_CUTOFF_REGRESSION"));
});

test("freshness gate rejects a stale hard-coded as_of_note once a source has current rows", () => {
  const fixture = currentPbpFixture();
  // Regression of the exact Phase 10 metadata debt: the old hard-coded sentence.
  (fixture.audit as Record<string, unknown>).as_of_note =
    "As of generation, 0 rows of ANY 2026 source are cached; newest data is 2025.";
  const { child, result } = runGate(fixture);
  assert.equal(child.status, 2);
  assert.equal(result.status, "FAIL");
  assert.ok(result.failures.some((failure) => failure.code === "AUDIT_AS_OF_NOTE_NOT_STALE"));
});

test("freshness gate rejects a prior-only audit whose as_of_note does not say so", () => {
  const fixture = priorOnlyFixture();
  (fixture.audit as Record<string, unknown>).as_of_note =
    "As of generation, everything looks current and fresh for 2026.";
  const { child, result } = runGate(fixture);
  assert.equal(child.status, 2);
  assert.ok(result.failures.some((failure) => failure.code === "AUDIT_AS_OF_NOTE_ACKNOWLEDGES_PRIOR_ONLY"));
});

test("freshness gate rejects accidental Player x Scheme predictive promotion", () => {
  const fixture = currentPbpFixture();
  fixture.psi = {
    ...fixture.psi,
    fantasy_adjustment_enabled: true,
    tier_d: { lane: "PRODUCTION", numeric_fantasy_adjustment: 0.25 },
  };
  const { child, result } = runGate(fixture);
  assert.equal(child.status, 2);
  assert.ok(result.failures.some((failure) => failure.code === "PSI_SHADOW_NOT_PROMOTED"));
});
