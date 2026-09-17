/**
 * Intelligence Modernization Phase 1, Checkpoint B — freshness evaluator
 * tests. No network. Pure fixtures. Covers the 30 scenarios enumerated in
 * docs/INTELLIGENCE_MODERNIZATION_PHASE_1_AUDIT.md's test plan (Checkpoint B
 * instructions), grouped exactly as specified: completed-game frontier,
 * source-family behavior, compatibility, semantics, determinism, production
 * isolation.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, describe } from "node:test";

import {
  assessIntelligenceFreshness,
  summarizeIntelligenceFreshness,
  FRESHNESS_POLICY_VERSION,
  type IntelligenceFreshnessRequest,
  type NflRealityFrontier,
} from "@/lib/canonical/intelligence-freshness";
import type {
  RecommendationLineage,
  SnapshotLineage,
  FootballIntelligenceLineage,
} from "@/lib/canonical/lineage";
import { fiMayInfluenceProduction } from "@/lib/weekly/start-sit-fi/deployment";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function snapshot(overrides: Partial<SnapshotLineage> = {}): SnapshotLineage {
  return {
    league_snapshot_id: "snap:bloodline-bowl:2026:w2:abc1230000000000",
    snapshot_schema_version: 3,
    content_hash: "abc1230000000000000000000000000000000000000000000000000000000",
    generated_at: "2026-09-17T04:00:00Z",
    provider: "sleeper",
    league_slug: "bloodline-bowl",
    league_id: "112233",
    season: 2026,
    week: 2,
    scoring_fingerprint: "scoring:v1:aaaaaaaaaaaaaaaaaaaaaaaa",
    roster_fingerprint: "roster-fp-aaa",
    player_data_version: "pdv-aaa",
    crosswalk_version: null,
    ...overrides,
  };
}

function fiWeek1Complete(overrides: Partial<FootballIntelligenceLineage> = {}): FootballIntelligenceLineage {
  return {
    version: "fi:2026:w01:ab802a853780",
    model_tag: "ri-football-intel-2026.1",
    season: 2026,
    through_week: 1,
    week_completion: {
      latest_week: 1,
      week_state: "COMPLETE",
      games_completed_in_latest_week: 16,
      games_scheduled_in_latest_week: 16,
      latest_completed_game_date: "2026-09-14",
    },
    data_cutoff: {
      pbp: 1,
      ngs_passing: 1,
      ngs_rushing: 1,
      ngs_receiving: 1,
      pfr_pass: 1,
      pfr_def: 1,
      snap_counts: 1,
      ftn_charting: 1,
      // participation deliberately absent -- matches real, live, current state.
    },
    output_classes: ["OBSERVED", "MODELED", "DESCRIPTIVE_ONLY"],
    generated_at: "2026-09-16T17:27:34Z",
    ...overrides,
  };
}

function baseLineage(overrides: Partial<RecommendationLineage> = {}): RecommendationLineage {
  return {
    snapshot: snapshot(),
    projections: [],
    football_intelligence: null,
    engine_versions: { test_engine: "v1" },
    ...overrides,
  };
}

function reality(overrides: Partial<NflRealityFrontier> = {}): NflRealityFrontier {
  return {
    season: 2026,
    latest_week_with_any_completed_game: 1,
    completed_games_in_latest_week: 16,
    scheduled_games_in_latest_week: 16,
    as_of: "2026-09-17T04:00:00Z",
    ...overrides,
  };
}

function request(overrides: Partial<IntelligenceFreshnessRequest> = {}): IntelligenceFreshnessRequest {
  return {
    lineage: baseLineage({ football_intelligence: fiWeek1Complete() }),
    operation: "MATCHUP",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. completed-game frontier
// ---------------------------------------------------------------------------
describe("completed-game frontier", () => {
  test("1. Sleeper week 2 + FI complete week 1 + zero week-2 games completed -> CURRENT", () => {
    const a = assessIntelligenceFreshness(
      request({ nfl_reality: reality({ latest_week_with_any_completed_game: 1, completed_games_in_latest_week: 16 }) }),
    );
    assert.equal(a.overall_status, "CURRENT");
    assert.equal(a.usable, true);
    assert.equal(a.fallback_required, false);
  });

  test("2. a Week-2 game becomes final but FI has not incorporated it -> STALE for an FI-dependent operation", () => {
    const r = reality({ latest_week_with_any_completed_game: 2, completed_games_in_latest_week: 1, scheduled_games_in_latest_week: 15 });
    const matchup = assessIntelligenceFreshness(request({ operation: "MATCHUP", nfl_reality: r }));
    assert.equal(matchup.overall_status, "STALE");
    assert.equal(matchup.confidence_cap, "LOW");
    assert.equal(matchup.fallback_required, true);
    assert.ok(matchup.reasons.some((x) => x.code === "FI_BEHIND_COMPLETED_GAMES"));

    // same underlying staleness, but WAIVER (LOW materiality, FI not consumed
    // by production) must not be forced into a fallback -- there's nothing
    // FI-derived in its production number to fall back FROM.
    const waiver = assessIntelligenceFreshness(request({ operation: "WAIVER", nfl_reality: r }));
    assert.equal(waiver.overall_status, "STALE");
    assert.equal(waiver.fallback_required, false);
    assert.notEqual(waiver.confidence_cap, "LOW");
  });

  test("3. FI Week 2 PARTIAL 1/15, matching reality exactly -> PARTIAL_CURRENT", () => {
    const fi = fiWeek1Complete({
      through_week: 2,
      week_completion: { latest_week: 2, week_state: "PARTIAL", games_completed_in_latest_week: 1, games_scheduled_in_latest_week: 15, latest_completed_game_date: "2026-09-17" },
    });
    const a = assessIntelligenceFreshness(
      request({
        lineage: baseLineage({ football_intelligence: fi }),
        nfl_reality: reality({ latest_week_with_any_completed_game: 2, completed_games_in_latest_week: 1, scheduled_games_in_latest_week: 15 }),
      }),
    );
    assert.equal(a.overall_status, "PARTIAL_CURRENT");
    assert.equal(a.usable, true);
  });

  test("4. FI Week 2 COMPLETE, all scheduled games incorporated -> CURRENT", () => {
    const fi = fiWeek1Complete({
      through_week: 2,
      week_completion: { latest_week: 2, week_state: "COMPLETE", games_completed_in_latest_week: 15, games_scheduled_in_latest_week: 15, latest_completed_game_date: "2026-09-21" },
    });
    const a = assessIntelligenceFreshness(
      request({
        lineage: baseLineage({ football_intelligence: fi }),
        nfl_reality: reality({ latest_week_with_any_completed_game: 2, completed_games_in_latest_week: 15, scheduled_games_in_latest_week: 15 }),
      }),
    );
    assert.equal(a.overall_status, "CURRENT");
  });
});

// ---------------------------------------------------------------------------
// 2. source-family behavior
// ---------------------------------------------------------------------------
describe("feature-family behavior", () => {
  test("5. PBP current, snap counts lagging normally", () => {
    const fi = fiWeek1Complete({ through_week: 2, data_cutoff: { ...fiWeek1Complete().data_cutoff, pbp: 2, snap_counts: 1 } });
    const a = assessIntelligenceFreshness(request({ lineage: baseLineage({ football_intelligence: fi }) }));
    const pbp = a.feature_families.find((f) => f.family === "PBP_TEAM_EFFICIENCY")!;
    const snaps = a.feature_families.find((f) => f.family === "SNAP_COUNTS")!;
    assert.equal(pbp.lag_classification, "AT_CUTOFF");
    assert.equal(snaps.lag_classification, "EXPECTED_SOURCE_LAG");
    assert.equal(snaps.lag_weeks, 1);
  });

  test("6. PBP current, PFR lagging normally", () => {
    const fi = fiWeek1Complete({ through_week: 2, data_cutoff: { ...fiWeek1Complete().data_cutoff, pbp: 2, pfr_pass: 1, pfr_def: 1 } });
    const a = assessIntelligenceFreshness(request({ lineage: baseLineage({ football_intelligence: fi }) }));
    const pfr = a.feature_families.find((f) => f.family === "PFR_PRESSURE")!;
    assert.equal(pfr.lag_classification, "EXPECTED_SOURCE_LAG");
  });

  test("7. participation unavailable for the current season", () => {
    const a = assessIntelligenceFreshness(request());
    const route = a.feature_families.find((f) => f.family === "ROUTE_PARTICIPATION")!;
    assert.equal(route.availability, "UNAVAILABLE");
    assert.equal(route.data_cutoff_week, null);
    assert.equal(route.predictive_eligibility, "NOT_ELIGIBLE");
    assert.ok(a.reasons.some((x) => x.code === "SOURCE_UNAVAILABLE_FOR_SEASON" && x.affects.includes("ROUTE_PARTICIPATION")));
  });

  test("8. FTN current but DESCRIPTIVE_ONLY", () => {
    const a = assessIntelligenceFreshness(request());
    const ftn = a.feature_families.find((f) => f.family === "FTN_DESCRIPTIVE")!;
    assert.equal(ftn.lag_classification, "AT_CUTOFF");
    assert.equal(ftn.predictive_eligibility, "DESCRIPTIVE_ONLY");
    assert.ok(a.prohibited_features.includes("FTN_DESCRIPTIVE"));
  });

  test("9. one unavailable optional source does not invalidate an unrelated feature family", () => {
    const a = assessIntelligenceFreshness(request()); // participation absent, pbp present
    const pbp = a.feature_families.find((f) => f.family === "PBP_TEAM_EFFICIENCY")!;
    const route = a.feature_families.find((f) => f.family === "ROUTE_PARTICIPATION")!;
    assert.equal(pbp.availability, "AVAILABLE");
    assert.equal(route.availability, "UNAVAILABLE");
    assert.notEqual(a.overall_status, "STALE"); // one optional absence alone must not escalate to STALE
  });

  test("10. source regression is more severe than expected lag", () => {
    const previous = fiWeek1Complete({ data_cutoff: { ...fiWeek1Complete().data_cutoff, pfr_pass: 1 } });
    const regressed = fiWeek1Complete({ data_cutoff: { ...fiWeek1Complete().data_cutoff, pfr_pass: undefined as unknown as number } });
    delete (regressed.data_cutoff as Record<string, number>).pfr_pass;

    const regressedAssessment = assessIntelligenceFreshness(
      request({ lineage: baseLineage({ football_intelligence: regressed }), previous_football_intelligence: previous }),
    );
    const laggingOnly = fiWeek1Complete({ through_week: 2, data_cutoff: { ...fiWeek1Complete().data_cutoff, pbp: 2, pfr_pass: 1 } });
    const lagAssessment = assessIntelligenceFreshness(request({ lineage: baseLineage({ football_intelligence: laggingOnly }) }));

    const regressedPfr = regressedAssessment.feature_families.find((f) => f.family === "PFR_PRESSURE")!;
    assert.equal(regressedPfr.lag_classification, "BROKEN_OR_MISSING_DATA");
    assert.equal(regressedAssessment.overall_status, "STALE");
    assert.notEqual(lagAssessment.overall_status, "STALE");
  });
});

// ---------------------------------------------------------------------------
// 3. compatibility
// ---------------------------------------------------------------------------
describe("compatibility", () => {
  test("11. wrong league lineage -> INCOMPATIBLE", () => {
    const a = assessIntelligenceFreshness(request({ expected_league_id: "999999" }));
    assert.equal(a.overall_status, "INCOMPATIBLE");
    assert.equal(a.usable, false);
    assert.ok(a.reasons.some((x) => x.code === "LEAGUE_MISMATCH"));
  });

  test("12. wrong season -> INCOMPATIBLE", () => {
    const a = assessIntelligenceFreshness(request({ expected_season: 2025 }));
    assert.equal(a.overall_status, "INCOMPATIBLE");
    assert.ok(a.reasons.some((x) => x.code === "SEASON_MISMATCH"));
  });

  test("13. impossible future data (FI ahead of the reality frontier) -> INCOMPATIBLE", () => {
    const fi = fiWeek1Complete({
      through_week: 5,
      week_completion: { latest_week: 5, week_state: "COMPLETE", games_completed_in_latest_week: 16, games_scheduled_in_latest_week: 16, latest_completed_game_date: "2026-10-12" },
    });
    const a = assessIntelligenceFreshness(
      request({ lineage: baseLineage({ football_intelligence: fi }), nfl_reality: reality({ latest_week_with_any_completed_game: 1 }) }),
    );
    assert.equal(a.overall_status, "INCOMPATIBLE");
    assert.ok(a.reasons.some((x) => x.code === "FI_AHEAD_OF_REALITY"));
  });

  test("14. scoring contract mismatch -> INCOMPATIBLE", () => {
    const a = assessIntelligenceFreshness(
      request({
        lineage: baseLineage({
          football_intelligence: null,
          projections: [{ role: "weekly_absolute", source: "sleeper_weekly", model_version: "v1", generated_at: null, scoring_fingerprint: "scoring:v1:zzzzzzzzzzzzzzzzzzzzzzzz", status: "READY" }],
        }),
      }),
    );
    assert.equal(a.overall_status, "INCOMPATIBLE");
    assert.ok(a.reasons.some((x) => x.code === "SCORING_FINGERPRINT_MISMATCH"));
  });

  test("15. mixed incompatible lineage versions (FI season != snapshot season, no historical flag) -> INCOMPATIBLE", () => {
    const fi = fiWeek1Complete({ season: 2025 });
    const a = assessIntelligenceFreshness(request({ lineage: baseLineage({ football_intelligence: fi }) }));
    assert.equal(a.overall_status, "INCOMPATIBLE");
    assert.ok(a.reasons.some((x) => x.code === "FI_SEASON_MISMATCH"));

    // the same mismatch, explicitly permitted for historical/ROS analysis, is NOT incompatible
    const historical = assessIntelligenceFreshness(
      request({ operation: "TRADE", lineage: baseLineage({ football_intelligence: fi }), allow_historical_football_intelligence: true }),
    );
    assert.notEqual(historical.overall_status, "INCOMPATIBLE");
  });

  test("16. null/unavailable fields remain explicitly unavailable, never fabricated", () => {
    const a = assessIntelligenceFreshness(request({ lineage: baseLineage({ football_intelligence: null }) }));
    assert.ok(a.reasons.some((x) => x.code === "FI_NOT_USED"));
    for (const f of a.feature_families) {
      if (f.family === "LEAGUE_STATE" || f.family === "SCORING" || f.family === "SCHEDULE") continue;
      assert.equal(f.availability, "UNAVAILABLE");
      assert.equal(f.data_cutoff_week, null);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. semantics ("no false precision")
// ---------------------------------------------------------------------------
describe("semantics", () => {
  test("17. missing != zero", () => {
    const a = assessIntelligenceFreshness(request());
    const route = a.feature_families.find((f) => f.family === "ROUTE_PARTICIPATION")!;
    assert.notEqual(route.data_cutoff_week, 0);
    assert.equal(route.data_cutoff_week, null);
  });

  test("18. snap share != route share (independent families, never substituted)", () => {
    const fi = fiWeek1Complete(); // snap_counts present, participation absent
    const a = assessIntelligenceFreshness(request({ lineage: baseLineage({ football_intelligence: fi }) }));
    const snaps = a.feature_families.find((f) => f.family === "SNAP_COUNTS")!;
    const routes = a.feature_families.find((f) => f.family === "ROUTE_PARTICIPATION")!;
    assert.equal(snaps.availability, "AVAILABLE");
    assert.equal(routes.availability, "UNAVAILABLE");
    // PLAYER_USAGE (which needs both) must reflect the worse of the two, not silently use snap_counts as a stand-in.
    const usage = a.feature_families.find((f) => f.family === "PLAYER_USAGE")!;
    assert.equal(usage.availability, "UNAVAILABLE");
  });

  test("19. current != production-authorized", () => {
    const a = assessIntelligenceFreshness(request({ nfl_reality: reality() }));
    assert.equal(a.overall_status, "CURRENT");
    for (const f of a.feature_families) {
      if (f.production_numeric_influence === "NOT_APPLICABLE") continue;
      assert.equal(f.production_numeric_influence, "PROHIBITED");
    }
  });

  test("20. predictive != production-authorized", () => {
    const a = assessIntelligenceFreshness(request());
    const pbp = a.feature_families.find((f) => f.family === "PBP_TEAM_EFFICIENCY")!;
    assert.equal(pbp.predictive_eligibility, "PREDICTIVE_ELIGIBLE");
    assert.equal(pbp.production_numeric_influence, "PROHIBITED");
  });

  test("21. descriptive-only != predictive, regardless of freshness", () => {
    const current = assessIntelligenceFreshness(request());
    const laggingFtn = fiWeek1Complete({ through_week: 2, data_cutoff: { ...fiWeek1Complete().data_cutoff, pbp: 2, ftn_charting: 1 } });
    const lagging = assessIntelligenceFreshness(request({ lineage: baseLineage({ football_intelligence: laggingFtn }) }));
    for (const a of [current, lagging]) {
      const ftn = a.feature_families.find((f) => f.family === "FTN_DESCRIPTIVE")!;
      assert.equal(ftn.predictive_eligibility, "DESCRIPTIVE_ONLY");
    }
  });

  test("22. model version freshness does not imply data freshness", () => {
    // a brand-new model_tag/version string with season/week behind reality is still STALE.
    const fi = fiWeek1Complete({ model_tag: "ri-football-intel-2027.9", version: "fi:2026:w01:zzzzzzzzzzzz" });
    const a = assessIntelligenceFreshness(
      request({ lineage: baseLineage({ football_intelligence: fi }), nfl_reality: reality({ latest_week_with_any_completed_game: 3, completed_games_in_latest_week: 1 }) }),
    );
    assert.equal(a.overall_status, "STALE");
  });

  test("23. data freshness does not imply model deployment authorization", () => {
    const a = assessIntelligenceFreshness(request({ nfl_reality: reality() }));
    assert.equal(a.overall_status, "CURRENT");
    assert.equal(a.fallback_required, false);
    // CURRENT data must still never grant production numeric influence in Checkpoint B.
    assert.ok(a.feature_families.every((f) => f.production_numeric_influence !== undefined));
    assert.equal(fiMayInfluenceProduction(null, "QB"), false);
  });
});

// ---------------------------------------------------------------------------
// 5. determinism
// ---------------------------------------------------------------------------
describe("determinism", () => {
  test("24. identical inputs produce deep-equal assessments", () => {
    const req = request({ nfl_reality: reality() });
    const a = assessIntelligenceFreshness(req);
    const b = assessIntelligenceFreshness(request({ nfl_reality: reality() }));
    assert.deepEqual(a, b);
  });

  test("25. reason and feature-family ordering is deterministic regardless of input key order", () => {
    const fiA = fiWeek1Complete({ data_cutoff: { pbp: 1, snap_counts: 1, pfr_pass: 1, pfr_def: 1, ngs_passing: 1, ngs_rushing: 1, ngs_receiving: 1, ftn_charting: 1 } });
    const fiB = fiWeek1Complete({ data_cutoff: { ftn_charting: 1, ngs_receiving: 1, ngs_rushing: 1, ngs_passing: 1, pfr_def: 1, pfr_pass: 1, snap_counts: 1, pbp: 1 } });
    const a = assessIntelligenceFreshness(request({ lineage: baseLineage({ football_intelligence: fiA }) }));
    const b = assessIntelligenceFreshness(request({ lineage: baseLineage({ football_intelligence: fiB }) }));
    assert.deepEqual(a.feature_families.map((f) => f.family), b.feature_families.map((f) => f.family));
    assert.deepEqual(a.reasons, b.reasons);
  });
});

// ---------------------------------------------------------------------------
// 6. production isolation
// ---------------------------------------------------------------------------
describe("production isolation (Checkpoint B must not change any of this)", () => {
  test("29. no new caller of the dormant FI production function", () => {
    const roots = ["lib", "app"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          if (entry === "node_modules" || entry === ".next") continue;
          walk(full);
        } else if (/\.tsx?$/.test(entry) && !full.includes("start-sit-fi/production-gate.ts")) {
          const contents = readFileSync(full, "utf8");
          if (contents.includes("applyFiToProductionBatch(")) offenders.push(full);
        }
      }
    };
    for (const r of roots) walk(r);
    assert.deepEqual(offenders, []);
  });

  test("30. the Start/Sit FI production gate is unchanged: fiMayInfluenceProduction() is false for every position", () => {
    for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"] as const) {
      assert.equal(fiMayInfluenceProduction(null, pos), false);
    }
  });
});

// ---------------------------------------------------------------------------
// human-readable summary sanity
// ---------------------------------------------------------------------------
test("summarizeIntelligenceFreshness renders from the typed assessment, not free text", () => {
  const a = assessIntelligenceFreshness(request({ nfl_reality: reality() }));
  const text = summarizeIntelligenceFreshness(a);
  assert.match(text, /League state:/);
  assert.match(text, new RegExp(FRESHNESS_POLICY_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, /Overall: CURRENT/);
});
