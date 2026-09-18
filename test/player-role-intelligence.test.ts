/**
 * Player Role & Opportunity Intelligence — Checkpoint D tests.
 * Covers: reader tests, artifact validation, lineage/freshness integration,
 * structural production isolation. No network. Reads only the committed
 * served artifacts under lib/player-role-intelligence/data/.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test, describe } from "node:test";

import {
  loadRoleOpportunitySnapshot,
  __resetRoleOpportunityCache,
  validateRoleOpportunitySnapshot,
} from "@/lib/player-role-intelligence/read";
import { buildRoleOpportunityIntelligenceLineage } from "@/lib/player-role-intelligence/lineage";
import { formatPlayerRoleProfile, formatRoleChangeEvent, formatRoleOpportunityLineage } from "@/lib/player-role-intelligence/format";
import {
  assessRoleOpportunityFreshness,
  ROLE_INTELLIGENCE_FEATURE_FAMILIES,
  FRESHNESS_POLICY_VERSION,
} from "@/lib/canonical/intelligence-freshness";
import type { RecommendationLineage, SnapshotLineage, RoleOpportunityIntelligenceLineage } from "@/lib/canonical/lineage";
import { buildRecommendationLineage } from "@/lib/canonical/lineage";

// ---------------------------------------------------------------------------
// reader tests
// ---------------------------------------------------------------------------
describe("loadRoleOpportunitySnapshot", () => {
  test("1: manifest reads", () => {
    const snap = loadRoleOpportunitySnapshot();
    assert.ok(snap, "expected a served snapshot to exist");
    assert.match(snap!.manifest.role_opportunity_version, /^roi:\d{4}:w\d{2}:[0-9a-f]{12}$/);
    assert.equal(snap!.manifest.deployment_state, "SHARED_CONTEXT");
    assert.equal(snap!.manifest.eligible_to_influence_production, false);
  });

  test("2: profile reads", () => {
    const snap = loadRoleOpportunitySnapshot()!;
    assert.ok(snap.profiles.length > 0);
    const p = snap.profiles[0]!;
    assert.ok(p.identity.gsis_id);
    assert.ok(["MINIMAL", "ROTATIONAL", "REGULAR", "FEATURED", "PRIMARY", null].includes(p.role_state.role_level));
  });

  test("3: role-change events read", () => {
    const snap = loadRoleOpportunitySnapshot()!;
    assert.ok(Array.isArray(snap.events));
    for (const e of snap.events) {
      assert.ok(["EXPANDING", "STABLE", "CONTRACTING", "UNCERTAIN"].includes(e.trend));
      assert.notEqual(e.trend, "STABLE", "served events must only be non-STABLE/UNCERTAIN trends");
    }
  });

  test("4/9: player lookup by gsis_id works; return specialist parses with offense untouched", () => {
    const snap = loadRoleOpportunitySnapshot()!;
    const target = snap.profiles.find((p) => p.identity.full_name === "Amon-Ra St. Brown");
    assert.ok(target);
    const byId = snap.getPlayerRoleProfile({ gsis_id: target!.identity.gsis_id });
    assert.equal(byId, target);

    const returner = snap.profiles.find((p) => (p.returns.kick_return_role.latest ?? 0) > 0.5 || (p.returns.punt_return_role.latest ?? 0) > 0.5);
    if (returner) {
      assert.ok((returner.participation?.latest ?? 0) < 0.5, "a return specialist's offensive participation must stay low, never inflated by return role");
    }
  });

  test("5: unknown player returns explicit null", () => {
    const snap = loadRoleOpportunitySnapshot()!;
    assert.equal(snap.getPlayerRoleProfile({ gsis_id: "00-9999999" }), null);
    assert.equal(snap.getPlayerRoleChanges({ gsis_id: "00-9999999" }).length, 0);
  });

  test("6/7: null routes remain null; no TPRR field exists anywhere in the schema", () => {
    const snap = loadRoleOpportunitySnapshot()!;
    const wr = snap.profiles.find((p) => p.receiving && p.receiving.target_share.latest != null);
    assert.ok(wr?.receiving);
    // Checkpoint B/C established 2026 route data is genuinely unavailable --
    // verified again here at the served-artifact layer.
    assert.equal(wr!.receiving!.route_participation.latest, null);
    assert.equal(wr!.receiving!.route_participation.confidence, "INSUFFICIENT_SAMPLE");
    const flat = JSON.stringify(wr).toLowerCase();
    assert.ok(!flat.includes("tprr") && !flat.includes("targets_per_route_run"), "no TPRR field should ever be exposed at the profile layer");
  });

  test("10: role confidence and trend parse to valid enum values only", () => {
    const snap = loadRoleOpportunitySnapshot()!;
    const validConf = new Set(["HIGH", "MEDIUM", "LOW", "INSUFFICIENT_SAMPLE"]);
    const validTrend = new Set(["EXPANDING", "STABLE", "CONTRACTING", "UNCERTAIN"]);
    for (const p of snap.profiles.slice(0, 50)) {
      if (p.participation) {
        assert.ok(validConf.has(p.participation.confidence));
        assert.ok(validTrend.has(p.participation.trend_latest_vs_recent));
      }
    }
  });

  test("12: version identity is internally consistent across manifest and lineage", () => {
    const snap = loadRoleOpportunitySnapshot()!;
    const lineage = buildRoleOpportunityIntelligenceLineage(snap);
    assert.equal(lineage!.version, snap.manifest.role_opportunity_version);
    assert.equal(lineage!.model_tag, snap.manifest.role_opportunity_model_tag);
  });

  test("13/14/15: malformed input fails validation (duplicate keys, impossible shares, false-positive route availability)", () => {
    const snap = loadRoleOpportunitySnapshot()!;
    const baseProfile = structuredClone(snap.profiles[0]!);
    const baseManifest = structuredClone(snap.manifest);

    // duplicate keys
    assert.throws(() => validateRoleOpportunitySnapshot(baseManifest, [baseProfile, structuredClone(baseProfile)], []), /duplicate profile key/);

    // impossible share (>1)
    const impossible = structuredClone(baseProfile);
    if (impossible.rushing) impossible.rushing.rush_share.latest = 1.5;
    else if (impossible.receiving) impossible.receiving.target_share.latest = 1.5;
    assert.throws(() => validateRoleOpportunitySnapshot(baseManifest, [impossible], []), /out of bounds/);

    // available-but-all-null route family (exactly the Checkpoint A/B failure mode)
    const allNullRoutes = structuredClone(snap.profiles).map((p) => {
      if (p.receiving) p.receiving.route_participation.latest = null;
      return p;
    });
    const falsePositiveManifest = structuredClone(baseManifest);
    const routeFamily = falsePositiveManifest.source_availability.find((f) => f.family === "ROLE_ROUTES");
    assert.ok(routeFamily);
    routeFamily!.status = "AVAILABLE_CURRENT";
    assert.throws(() => validateRoleOpportunitySnapshot(falsePositiveManifest, allNullRoutes, []), /availability false positive/);
  });

  test("16: generated_at does not affect content identity (version is a content hash, not a timestamp)", () => {
    const snap = loadRoleOpportunitySnapshot()!;
    // the version string embeds no ISO-timestamp-shaped substring
    assert.doesNotMatch(snap.manifest.role_opportunity_version, /\d{4}-\d{2}-\d{2}/);
  });

  test("cache reset re-reads from disk without throwing", () => {
    __resetRoleOpportunityCache();
    const snap = loadRoleOpportunitySnapshot();
    assert.ok(snap);
  });
});

// ---------------------------------------------------------------------------
// formatter: renders only existing structured fields, no fantasy content
// ---------------------------------------------------------------------------
describe("formatters", () => {
  test("formatPlayerRoleProfile never mentions fantasy points, start/sit, or recommendations", () => {
    const snap = loadRoleOpportunitySnapshot()!;
    const p = snap.profiles.find((x) => x.receiving?.target_share.latest != null)!;
    const text = formatPlayerRoleProfile(p).toLowerCase();
    for (const banned of ["fantasy", "start/sit", "recommend", "should start", "should bench", "waiver", "trade value"]) {
      assert.ok(!text.includes(banned), `formatter output must not contain "${banned}"`);
    }
  });

  test("formatRoleChangeEvent and formatRoleOpportunityLineage run without throwing", () => {
    const snap = loadRoleOpportunitySnapshot()!;
    if (snap.events.length > 0) formatRoleChangeEvent(snap.events[0]!);
    formatRoleOpportunityLineage(buildRoleOpportunityIntelligenceLineage(snap));
    assert.equal(formatRoleOpportunityLineage(null), "Role & Opportunity Intelligence: NOT_USED");
  });
});

// ---------------------------------------------------------------------------
// lineage / freshness integration (Checkpoint D §33)
// ---------------------------------------------------------------------------
function snapshotLineage(overrides: Partial<SnapshotLineage> = {}): SnapshotLineage {
  return {
    league_snapshot_id: "snap:bloodline-bowl:2026:w2:abc1230000000000",
    snapshot_schema_version: 3,
    content_hash: "abc123",
    generated_at: "2026-09-17T04:00:00Z",
    provider: "sleeper",
    league_slug: "bloodline-bowl",
    league_id: "112233",
    season: 2026,
    week: 2,
    scoring_fingerprint: "sf1",
    roster_fingerprint: "rf1",
    player_data_version: "pdv1",
    crosswalk_version: null,
    ...overrides,
  };
}
function roiLineage(overrides: Partial<RoleOpportunityIntelligenceLineage> = {}): RoleOpportunityIntelligenceLineage {
  return {
    version: "roi:2026:w01:abcdef123456",
    model_tag: "role-opportunity-2026.1",
    feature_schema_version: "role-profile-model:v1",
    season: 2026,
    through_week: 1,
    week_completion: { latest_week: 1, week_state: "COMPLETE", games_completed_in_latest_week: 16, games_scheduled_in_latest_week: 16, latest_completed_game_date: "2026-09-14" },
    data_cutoff: { pbp: 1, snap_counts: 1 },
    substrate_schema_version: "role-opportunity-schema:v1",
    generated_at: "2026-09-17T20:00:00Z",
    ...overrides,
  };
}
function lineageWithRoi(roi: RoleOpportunityIntelligenceLineage | null, snapOverrides: Partial<SnapshotLineage> = {}): RecommendationLineage {
  return buildRecommendationLineage(snapshotLineage(snapOverrides), { test_engine: "1.0" }, [], null, roi);
}

describe("assessRoleOpportunityFreshness", () => {
  test("1: current Week 1 role snapshot + Week 2 nominal provider week before kickoff = CURRENT", () => {
    const lineage = lineageWithRoi(roiLineage());
    const result = assessRoleOpportunityFreshness({
      lineage,
      operation: "ANALYSIS_ONLY",
      nfl_reality: { season: 2026, latest_week_with_any_completed_game: 1, completed_games_in_latest_week: 16, scheduled_games_in_latest_week: 16, latest_completed_game_date: "2026-09-14", as_of: "2026-09-18T00:00:00Z" },
    });
    assert.equal(result.overall_status, "CURRENT");
    assert.equal(result.usable, true);
  });

  test("2: partial Week 2 role snapshot after one completed game = PARTIAL_CURRENT", () => {
    const lineage = lineageWithRoi(roiLineage({ through_week: 2, week_completion: { latest_week: 2, week_state: "PARTIAL", games_completed_in_latest_week: 1, games_scheduled_in_latest_week: 16, latest_completed_game_date: "2026-09-21" } }));
    const result = assessRoleOpportunityFreshness({
      lineage,
      operation: "ANALYSIS_ONLY",
      nfl_reality: { season: 2026, latest_week_with_any_completed_game: 2, completed_games_in_latest_week: 1, scheduled_games_in_latest_week: 16, latest_completed_game_date: "2026-09-21", as_of: "2026-09-21T20:00:00Z" },
    });
    assert.equal(result.overall_status, "PARTIAL_CURRENT");
  });

  test("3: confirmed completed game missing from Role Intelligence = STALE (outside lag window)", () => {
    const lineage = lineageWithRoi(roiLineage({ generated_at: "2026-09-14T00:00:00Z" }));
    const farFuture = Date.parse("2026-09-14T00:00:00Z") + 48 * 3_600_000; // well beyond cadence+buffer
    const result = assessRoleOpportunityFreshness({
      lineage,
      operation: "ANALYSIS_ONLY",
      now: farFuture,
      nfl_reality: { season: 2026, latest_week_with_any_completed_game: 2, completed_games_in_latest_week: 5, scheduled_games_in_latest_week: 16, latest_completed_game_date: "2026-09-21", as_of: "2026-09-21T20:00:00Z" },
    });
    assert.equal(result.overall_status, "STALE");
  });

  test("4: current snaps + lagged routes preserves mixed feature status (never collapsed)", () => {
    const lineage = lineageWithRoi(roiLineage({ data_cutoff: { pbp: 1, snap_counts: 1 } })); // no participation key -> UNAVAILABLE
    const result = assessRoleOpportunityFreshness({ lineage, operation: "ANALYSIS_ONLY" });
    const routes = result.feature_families.find((f) => f.family === "ROLE_ROUTES");
    const snaps = result.feature_families.find((f) => f.family === "ROLE_SNAPS");
    assert.equal(routes!.availability, "UNAVAILABLE");
    assert.equal(snaps!.availability, "AVAILABLE");
  });

  test("5: null/missing routes never become current", () => {
    const lineage = lineageWithRoi(roiLineage({ data_cutoff: { pbp: 1, snap_counts: 1 } }));
    const result = assessRoleOpportunityFreshness({ lineage, operation: "ANALYSIS_ONLY" });
    const routes = result.feature_families.find((f) => f.family === "ROLE_ROUTES");
    assert.notEqual(routes!.lag_classification, "AT_CUTOFF");
  });

  test("6: Role Intelligence lineage is separate from Football Intelligence lineage", () => {
    const lineage = lineageWithRoi(roiLineage());
    assert.equal(lineage.football_intelligence, null);
    assert.ok(lineage.role_opportunity_intelligence);
  });

  test("7/8/9: loading lineage is not itself production influence; deployment status independent of freshness; descriptive CURRENT state is not production-authorized", () => {
    const lineage = lineageWithRoi(roiLineage());
    const result = assessRoleOpportunityFreshness({
      lineage,
      operation: "WAIVER",
      nfl_reality: { season: 2026, latest_week_with_any_completed_game: 1, completed_games_in_latest_week: 16, scheduled_games_in_latest_week: 16, latest_completed_game_date: "2026-09-14", as_of: "2026-09-18T00:00:00Z" },
    });
    assert.equal(result.overall_status, "CURRENT");
    // being CURRENT and "usable" is never itself a production-influence grant --
    // every feature family is hardcoded PROHIBITED regardless of freshness.
    for (const f of result.feature_families) assert.equal(f.production_numeric_influence, "PROHIBITED");
    assert.deepEqual([...result.prohibited_features].sort(), [...ROLE_INTELLIGENCE_FEATURE_FAMILIES].sort());
  });

  test("10: wrong season becomes INCOMPATIBLE under existing policy", () => {
    const lineage = lineageWithRoi(roiLineage({ season: 2025 }), { season: 2026 });
    const result = assessRoleOpportunityFreshness({ lineage, operation: "ANALYSIS_ONLY", expected_season: 2026 });
    assert.equal(result.overall_status, "INCOMPATIBLE");
    assert.equal(result.usable, false);
  });

  test("11: identical input assessment is deterministic", () => {
    const lineage = lineageWithRoi(roiLineage());
    const reality = { season: 2026, latest_week_with_any_completed_game: 1, completed_games_in_latest_week: 16, scheduled_games_in_latest_week: 16, latest_completed_game_date: "2026-09-14", as_of: "2026-09-18T00:00:00Z" };
    const a = assessRoleOpportunityFreshness({ lineage, operation: "ANALYSIS_ONLY", nfl_reality: reality, now: 1000 });
    const b = assessRoleOpportunityFreshness({ lineage, operation: "ANALYSIS_ONLY", nfl_reality: reality, now: 1000 });
    assert.deepEqual(a, b);
  });

  test("null role_opportunity_intelligence reports ROLE_NOT_USED, still usable", () => {
    const lineage = lineageWithRoi(null);
    const result = assessRoleOpportunityFreshness({ lineage, operation: "ANALYSIS_ONLY" });
    assert.equal(result.usable, true);
    assert.ok(result.reasons.some((r) => r.code === "ROLE_NOT_USED"));
  });

  test("policy version matches the single shared Phase 1 freshness policy (no parallel policy)", () => {
    const lineage = lineageWithRoi(roiLineage());
    const result = assessRoleOpportunityFreshness({ lineage, operation: "ANALYSIS_ONLY" });
    assert.equal(result.freshness_policy_version, FRESHNESS_POLICY_VERSION);
  });
});

// ---------------------------------------------------------------------------
// structural production isolation (Checkpoint D §29)
// ---------------------------------------------------------------------------
describe("production isolation", () => {
  function grepDirForRoleIntelligence(dir: string): string[] {
    const hits: string[] = [];
    const fullDir = join(process.cwd(), dir);
    let dirents;
    try {
      dirents = readdirSync(fullDir, { withFileTypes: true });
    } catch {
      return hits;
    }
    for (const entry of dirents) {
      const full = join(fullDir, entry.name);
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) {
        hits.push(...grepDirForRoleIntelligence(rel));
      } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
        const text = readFileSync(full, "utf8");
        if (/player-role-intelligence|player_role/.test(text)) hits.push(rel);
      }
    }
    return hits;
  }

  test("no production consumer imports Phase 2 role-model code", () => {
    const hits = [
      ...grepDirForRoleIntelligence("lib/weekly"),
      ...grepDirForRoleIntelligence("lib/trades"),
      ...grepDirForRoleIntelligence("lib/orchestrator"),
      ...grepDirForRoleIntelligence("lib/projections"),
      ...grepDirForRoleIntelligence("app/api"),
    ];
    assert.deepEqual(hits, [], `unexpected Role Intelligence reference(s) in production code: ${hits.join(", ")}`);
  });

  test("lib/projections/model.ts is untouched by this checkpoint (no role-model import)", () => {
    const text = readFileSync(join(process.cwd(), "lib/projections/model.ts"), "utf8");
    assert.ok(!/player-role-intelligence|player_role/.test(text));
  });
});
