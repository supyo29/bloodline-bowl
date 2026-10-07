/**
 * Decision Model Convergence W1.P1 — canonical weekly player forecast.
 * Contract semantics, builder behaviour, golden production compatibility, provider neutrality, determinism.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CANONICAL_WEEKLY_FORECAST_VERSION,
  K_DST_FALLBACK_WARNING,
  buildCanonicalForecastBatch,
  buildCanonicalWeeklyPlayerForecast,
  explainForecast,
  getLegacyExpectedAvailability,
  getLegacyProjectedPoints,
  roleSignalFromShadowCandidate,
  validateForecastInvariants,
  type CanonicalWeeklyPlayerForecast,
  type ForecastShadowSignals,
} from "../lib/weekly/forecast";
import { shadowCandidate } from "../lib/role-calibration/shadow";
import {
  buildProjectionSnapshotArtifact,
  hydrateProjectionSnapshotBatch,
  PROJECTION_SNAPSHOT_MAX_AGE_MS,
} from "../lib/weekly/projections/canonical-snapshot";
import type { CanonicalPlayer } from "../lib/canonical/schema";
import type { WeeklyProjection, WeeklyProjectionBatch } from "../lib/weekly/schema";
import { GOLDEN, GOLDEN_IDS, buildGoldenContext } from "./fixtures/canonical-forecast-golden";

const row = (over: Partial<WeeklyProjection> = {}): WeeklyProjection => ({
  canonical_player_id: "p1", week: 5, season: 2026, position: "WR", nfl_team: "KC", opponent: "LV", is_home: null,
  projected_points: 14.6, floor_points: 9, ceiling_points: 22, std_dev: 5, projection_status: "projected",
  expected_availability: 1, is_bye: false, injury_status: null, rest_of_season_points: null, ros: null,
  source: "sleeper_weekly", model_version: "sleeper-weekly-rotowire", uncertainty_source: "position_volatility_heuristic", warnings: [], ...over,
});
const player = (over: Partial<CanonicalPlayer> = {}): CanonicalPlayer => ({
  canonical_player_id: "p1", full_name: "P One", first_name: null, last_name: null, position: "WR", eligible_positions: ["WR"],
  nfl_team: "KC", is_team_defense: false, status: null, injury_status: null, identifiers: { sleeper_id: "s1" },
  resolution: { method: "stable_id", confidence: "high", note: null }, ...over,
});
const batch = (over: Partial<WeeklyProjectionBatch> = {}): WeeklyProjectionBatch => ({
  league_slug: "l", season: 2026, week: 5, status: "READY", by_player: new Map(), resolved_players: new Map(),
  source: "sleeper_weekly", model_version: "sleeper-weekly-rotowire", missing: [], teams_with_games: ["KC", "LV"], warnings: [], ...over,
});
const build = (projection: WeeklyProjection | null, extra: Partial<Parameters<typeof buildCanonicalWeeklyPlayerForecast>[0]> = {}) =>
  buildCanonicalWeeklyPlayerForecast({ canonical_player_id: "p1", season: 2026, week: 5, projection, batch: batch(), player: player(), ...extra });
const clean = (f: CanonicalWeeklyPlayerForecast) => assert.deepEqual(validateForecastInvariants(f), []);

describe("W1.P1 contract semantics", () => {
  it("healthy player: source projection carries through unchanged; version stamped", () => {
    const f = build(row());
    assert.equal(f.model_version, CANONICAL_WEEKLY_FORECAST_VERSION);
    assert.equal(f.model_version, "canonical-weekly-forecast-2026.1");
    assert.equal(f.value_state, "PROJECTED");
    assert.equal(f.projection.source_points, 14.6);
    assert.equal(f.projection.conditional_active_points, 14.6);
    assert.equal(f.projection.expected_points, 14.6);
    assert.equal(f.projection.expected_points_basis, "SOURCE_PROJECTION");
    assert.equal(f.certification.state, "PRODUCTION");
    assert.deepEqual(f.contributions.map((c) => [c.component, c.points_delta, c.mode]), [["BASE_PROJECTION", 14.6, "PRODUCTION"]]);
    clean(f);
  });

  it("questionable player: provider status preserved; W1.P2 applies the injury discount via the ledger (SHADOW mode reproduces W1.P1 exactly)", () => {
    const q = row({ injury_status: "Questionable", expected_availability: 0.78 });
    const f = build(q);
    assert.equal(f.availability.status, "QUESTIONABLE");
    assert.equal(f.availability.injury_status, "Questionable");
    assert.equal(f.availability.source_heuristic_availability, 0.78);
    assert.equal(f.projection.source_points, 14.6);
    assert.ok(f.projection.expected_points! < 14.6, "W1.P2: injury risk now affects expected_points");
    assert.equal(f.availability.applied_to_expected_points, true);
    const shadow = build(q, { injury_mode: "SHADOW" });
    assert.equal(shadow.projection.expected_points, 14.6, "the W1.P1 behavior, on demand");
    assert.equal(shadow.availability.applied_to_expected_points, false);
    clean(f);
    clean(shadow);
  });

  it("injured (Out) player: expected is a known zero, source value retained, distinct from a bye and from missing data", () => {
    const f = build(row({ injury_status: "Out", expected_availability: 0.03 }));
    assert.equal(f.availability.status, "OUT");
    assert.equal(f.game_status.is_bye, false);
    assert.equal(f.projection.source_points, 14.6);
    assert.equal(f.projection.expected_points, 0);
    assert.equal(f.value_state, "KNOWN_UNAVAILABLE");
    clean(f);
  });

  it("BYE: explicit is_bye, compat-zero expected, underlying value NOT erased, cannot be mistaken for 'no value'", () => {
    const bye = row({ projected_points: 0, floor_points: 0, ceiling_points: 0, std_dev: 0, projection_status: "bye", expected_availability: 0, is_bye: true, warnings: ["bye_verified_by_schedule"] });
    const f = build(bye, { bye_source_points: 12 });
    assert.equal(f.game_status.is_bye, true);
    assert.equal(f.game_status.has_game, false);
    assert.equal(f.value_state, "BYE_VERIFIED");
    assert.equal(f.projection.expected_points, 0);
    assert.equal(f.projection.expected_points_basis, "BYE_COMPAT_ZERO");
    assert.equal(f.projection.source_points, 12, "underlying value stays visible");
    assert.equal(f.projection.conditional_active_points, 12, "conditional-active does not collapse to the bye zero");
    assert.equal(f.availability.status, "BYE");
    assert.equal(f.availability.probability_active, null, "a bye is not an injury");
    assert.ok(f.certification.warnings.includes("BYE_EXPECTED_POINTS_IS_COMPAT_ZERO_NOT_UNDERLYING_VALUE"));
    assert.equal(getLegacyProjectedPoints(f), 0);
    assert.equal(getLegacyExpectedAvailability(f), 0, "legacy bye availability reads 0 for compatibility");
    clean(f);
    // bye with no stale feed entry: conditional-active is null (unknown), never a fabricated 0
    const f2 = build(bye);
    assert.equal(f2.projection.source_points, null);
    assert.equal(f2.projection.conditional_active_points, null);
    assert.equal(f2.projection.expected_points, 0);
    clean(f2);
  });

  it("missing projection: never a confirmed zero; distinct states for missing player vs fetch failure vs unresolved identity", () => {
    const missing = build(null);
    assert.equal(missing.value_state, "SOURCE_MISSING_PLAYER");
    assert.equal(missing.projection.expected_points, null);
    assert.equal(missing.projection.source_points, null);
    assert.equal(missing.certification.state, "UNAVAILABLE");
    assert.equal(getLegacyProjectedPoints(missing), null);
    clean(missing);

    const fetchFail = build(null, { batch: batch({ status: "PROJECTIONS_UNAVAILABLE" }) });
    assert.equal(fetchFail.value_state, "SOURCE_FETCH_FAILURE");
    clean(fetchFail);

    const unresolved = build(null, { player: null });
    assert.equal(unresolved.value_state, "PLAYER_NOT_FOUND");
    clean(unresolved);

    const noGame = build(null, { game_status: { no_scheduled_game: true } });
    assert.equal(noGame.value_state, "NO_SCHEDULED_GAME");
    assert.equal(noGame.game_status.has_game, false);
    assert.equal(noGame.game_status.is_bye, false);
    clean(noGame);
  });

  it("known zero vs unknown: 0 is data, null is unknown, and states differ", () => {
    const zero = build(row({ projected_points: 0 }));
    assert.equal(zero.value_state, "KNOWN_ZERO_PROJECTION");
    assert.equal(zero.projection.expected_points, 0);
    assert.equal(zero.certification.state, "PRODUCTION");
    const unknown = build(row({ projected_points: null, projection_status: "unavailable" }));
    assert.equal(unknown.value_state, "PROJECTION_UNAVAILABLE");
    assert.equal(unknown.projection.expected_points, null);
    const totals = build(row({ projected_points: null, projection_status: "unavailable", warnings: ["only_precomputed_totals (x)"] }));
    assert.equal(totals.value_state, "UNSUPPORTED_SCORING_DATA");
    const out = build(row({ projected_points: null, projection_status: "out" }));
    assert.equal(out.value_state, "PLAYER_OUT_IN_SOURCE");
    assert.equal(out.projection.expected_points, null);
    for (const f of [zero, unknown, totals, out]) clean(f);
  });

  it("shadow Role signal: visible in contributions and provenance, never changes production expected_points", () => {
    const cand = shadowCandidate({ baseline: 14.6, xfp_forecast: 18, xfp_no_pressure: 17, p_absent: 0, confidence: "MEDIUM" });
    const shadow: ForecastShadowSignals = {
      role: roleSignalFromShadowCandidate(cand),
      matchup: { mode: "INFORMATIONAL", signal: { adjustment_points: -0.4, confidence: null } },
    };
    const f = build(row(), { shadow });
    assert.equal(f.role.mode, "SHADOW");
    assert.equal(f.role.signal?.adjustment_points, cand.role_adjustment);
    assert.ok(cand.role_adjustment !== 0, "fixture must exercise a non-zero shadow adjustment");
    assert.equal(f.matchup.mode, "INFORMATIONAL");
    assert.equal(f.environment.mode, "NOT_APPLIED");
    assert.equal(f.projection.expected_points, 14.6);
    const role = f.contributions.find((c) => c.component === "ROLE_CALIBRATION")!;
    assert.equal(role.mode, "SHADOW");
    assert.equal(role.points_delta, Math.round(cand.role_adjustment * 100) / 100);
    assert.equal(f.contributions.find((c) => c.component === "MATCHUP_INTELLIGENCE")!.mode, "INFORMATIONAL");
    assert.deepEqual(f.provenance.production_adjustments_applied, ["BASE_PROJECTION"]);
    assert.deepEqual(f.provenance.shadow_adjustments_computed, ["ROLE_CALIBRATION", "MATCHUP_INTELLIGENCE"]);
    clean(f);
  });

  it("kicker and DST: current value preserved; fallback limitation surfaced via warning, provenance and PARTIAL certification", () => {
    for (const pos of ["K", "DEF"]) {
      const f = build(row({ position: pos, projected_points: 8.2, warnings: ["k_dst_uses_sleeper_standard_points (x)"] }));
      assert.equal(f.projection.expected_points, 8.2);
      assert.equal(f.provenance.source_type, "K_DST_STANDARD_FALLBACK");
      assert.ok(f.certification.warnings.includes(K_DST_FALLBACK_WARNING));
      assert.equal(f.certification.state, "PARTIAL");
      assert.deepEqual(f.provenance.source_warnings, ["k_dst_uses_sleeper_standard_points (x)"]);
      clean(f);
    }
  });

  it("an upstream FI production adjustment is recognised: expected is kept, source is honestly unknown, state PARTIAL", () => {
    const f = build(row({ projected_points: 15.1, warnings: ["fi_production_adjustment_applied:v1"] }));
    assert.equal(f.projection.expected_points, 15.1);
    assert.equal(f.projection.expected_points_basis, "SOURCE_PLUS_FI_PRODUCTION");
    assert.equal(f.projection.source_points, null);
    assert.equal(f.certification.state, "PARTIAL");
    clean(f);
  });

  it("staleness is reported from snapshot age, never the wall clock", () => {
    const fresh = build(row(), { batch: batch({ canonical_snapshot: { read_path: "SUPABASE_HIT", artifact_id: "projsnap:abc", observed_at: "2026-10-04T00:00:00.000Z", age_ms: 1000, durable: true } }) });
    assert.equal(fresh.freshness.stale, false);
    assert.equal(fresh.freshness.snapshot_created_at, "2026-10-04T00:00:00.000Z");
    assert.equal(fresh.provenance.snapshot.artifact_id, "projsnap:abc");
    assert.equal(fresh.provenance.source_ids.projection_snapshot_artifact_id, "projsnap:abc");
    const stale = build(row(), { batch: batch({ canonical_snapshot: { read_path: "SUPABASE_HIT", artifact_id: "projsnap:abc", observed_at: "x", age_ms: PROJECTION_SNAPSHOT_MAX_AGE_MS + 1, durable: true } }) });
    assert.equal(stale.freshness.stale, true);
    assert.equal(stale.certification.state, "PARTIAL");
    assert.ok(stale.certification.warnings.includes("SOURCE_SNAPSHOT_STALE"));
    assert.equal(build(row()).freshness.stale, null, "unknown age is not asserted fresh");
  });

  it("uncertainty: confidence is never fabricated from points or band width", () => {
    const f = build(row());
    assert.equal(f.uncertainty.confidence, 1, "healthy: nothing to doubt; never derived from points or band width");
    assert.equal(f.uncertainty.variance, 25);
    assert.ok(f.uncertainty.reasons.includes("HEURISTIC_POSITION_VOLATILITY_BAND_NOT_FITTED_DISTRIBUTION"));
    assert.equal(f.projection.median, null);
  });

  it("determinism: identical inputs produce identical forecasts and batches", () => {
    const b = batch({ by_player: new Map([["p1", row()]]), resolved_players: new Map([["p1", player()]]) });
    const a1 = buildCanonicalForecastBatch({ batch: b, requested_player_ids: ["z-missing", "p1"] });
    const a2 = buildCanonicalForecastBatch({ batch: b, requested_player_ids: ["p1", "z-missing"] });
    assert.deepEqual([...a1.by_player.keys()], ["p1", "z-missing"]);
    assert.equal(JSON.stringify([...a1.by_player]), JSON.stringify([...a2.by_player]));
    assert.deepEqual(a1.counts, a2.counts);
    assert.equal(a1.by_player.get("z-missing")!.value_state, "PLAYER_NOT_FOUND");
  });

  it("builder never mutates the production batch", () => {
    const b = batch({ by_player: new Map([["p1", row()]]), resolved_players: new Map([["p1", player()]]) });
    const before = JSON.stringify([...b.by_player]);
    buildCanonicalForecastBatch({ batch: b, requested_player_ids: ["p1", "p2"] });
    assert.equal(JSON.stringify([...b.by_player]), before);
  });
});

describe("W1.P1 provider neutrality", () => {
  it("Yahoo-identified player (no sleeper_id) forecasts without any Sleeper field", () => {
    const y = player({ canonical_player_id: "p1", identifiers: { yahoo_player_key: "nfl.p.40001", yahoo_id: "40001" } });
    const f = build(row(), { player: y });
    assert.equal(f.projection.expected_points, 14.6);
    assert.equal(f.identifiers.sleeper_id, undefined);
    assert.equal(f.provenance.source_ids.yahoo_player_key, "nfl.p.40001");
    assert.equal("sleeper_id" in f.provenance.source_ids, false);
    clean(f);
  });
  it("forecast logic never references sleeper_id as a required field", () => {
    const src = readFileSync(join(process.cwd(), "lib/weekly/forecast/build.ts"), "utf8");
    assert.equal(/sleeper_id!/.test(src), false);
    assert.equal(/identifiers\.sleeper_id\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), false, "no direct identifiers.sleeper_id access; ids flow through the generic map");
  });
});

describe("W1.P1 golden production compatibility (real buildWeeklyTeamContext)", () => {
  it("canonical expected_points equals the legacy production value for every player the injury model did not change; legacy adapters reproduce legacy fields", async () => {
    const ctx = await buildGoldenContext();
    assert.ok(ctx.forecasts);
    let unchanged = 0;
    for (const id of GOLDEN_IDS) {
      const wp = ctx.projections.by_player.get(id);
      const f = ctx.forecasts!.by_player.get(id);
      assert.ok(f, `forecast missing for ${id}`);
      if (!f!.availability.applied_to_expected_points) {
        assert.equal(getLegacyProjectedPoints(f), wp?.projected_points ?? null, `expected_points drift for ${id}`);
        unchanged += 1;
      }
      if (wp) assert.equal(getLegacyExpectedAvailability(f), wp.expected_availability, `availability drift for ${id}`);
      assert.deepEqual(validateForecastInvariants(f!), [], id);
      assert.equal(f!.model_version, CANONICAL_WEEKLY_FORECAST_VERSION);
    }
    assert.ok(unchanged >= 14, "most of the golden roster is unaffected by the injury model");
  });

  it("each golden case lands in its intended semantic state", async () => {
    const f = (await buildGoldenContext()).forecasts!.by_player;
    const state = (id: string) => f.get(id)!.value_state;
    assert.equal(state("g-qb"), "PROJECTED");
    assert.equal(state("g-rb-q"), "PROJECTED");
    assert.equal(state("g-wr-out"), "KNOWN_UNAVAILABLE");
    assert.equal(state("g-te-zero"), "KNOWN_ZERO_PROJECTION");
    assert.equal(state("g-k"), "PROJECTED");
    assert.equal(state("g-def"), "PROJECTED");
    assert.equal(state("g-rb-bye"), "BYE_VERIFIED");
    assert.equal(state("g-def-bye"), "BYE_VERIFIED");
    assert.equal(state("g-wr-missing"), "SOURCE_MISSING_PLAYER");
    assert.equal(state("g-rb-totals"), "UNSUPPORTED_SCORING_DATA");
    assert.equal(state("g-te-yahoo"), "PROJECTED");
    // F1 fixed in W1.P2: a source "out" now survives context assembly; unknown value, never zero
    assert.equal(state("g-rb-out-src"), "PLAYER_OUT_IN_SOURCE");
    assert.equal(f.get("g-rb-out-src")!.projection.expected_points, null);
    // bye with a stale feed entry keeps its underlying value visible
    assert.equal(f.get("g-rb-bye")!.projection.source_points, 12);
    assert.equal(f.get("g-rb-bye")!.projection.expected_points, 0);
    assert.equal(f.get("g-def-bye")!.projection.source_points, null);
    // injured / questionable are discounted by the W1.P2 injury model; the source value is still visible
    assert.equal(f.get("g-wr-out")!.projection.expected_points, 0);
    assert.equal(f.get("g-wr-out")!.projection.source_points, 9.1);
    assert.equal(f.get("g-wr-out")!.availability.status, "OUT");
    assert.equal(f.get("g-rb-q")!.projection.source_points, 14.6);
    assert.ok(f.get("g-rb-q")!.projection.expected_points! < 14.6);
    // Yahoo identity: forecast works with no sleeper id present
    assert.equal(f.get("g-te-yahoo")!.identifiers.sleeper_id, undefined);
    assert.equal(f.get("g-te-yahoo")!.projection.expected_points, 7.7);
    // K/DST fallback surfaced
    assert.ok(f.get("g-k")!.certification.warnings.includes(K_DST_FALLBACK_WARNING));
    assert.ok(f.get("g-def")!.certification.warnings.includes(K_DST_FALLBACK_WARNING));
    assert.equal(GOLDEN.length, f.size);
  });

  it("shadow signals layered on the production context do not move any production number", async () => {
    const ctx = await buildGoldenContext();
    const shadow = new Map<string, ForecastShadowSignals>([
      ["g-qb", { role: { mode: "SHADOW", signal: { state: null, adjustment_points: 1.2, confidence: 0.5 } }, environment: { mode: "SHADOW", signal: { adjustment_points: 0.6, confidence: 0.4 } } }],
      ["g-rb-q", { matchup: { mode: "INFORMATIONAL", signal: { adjustment_points: -0.4, confidence: null } } }],
    ]);
    const withShadow = buildCanonicalForecastBatch({ batch: ctx.projections, requested_player_ids: ctx.roster.all_players, players: new Map(ctx.all_rostered.map((p) => [p.canonical_player_id, p])), shadow });
    for (const id of GOLDEN_IDS) {
      assert.equal(withShadow.by_player.get(id)!.projection.expected_points, ctx.forecasts!.by_player.get(id)!.projection.expected_points, id);
      assert.deepEqual(validateForecastInvariants(withShadow.by_player.get(id)!), [], id);
    }
    assert.equal(withShadow.counts.with_shadow_signal, 2);
  });

  it("context forecast is deterministic across independent builds", async () => {
    const a = await buildGoldenContext();
    const b = await buildGoldenContext();
    assert.equal(JSON.stringify([...a.forecasts!.by_player]), JSON.stringify([...b.forecasts!.by_player]));
  });
});

describe("W1.P1 persistence reuse (option C: constructed from the existing snapshot at read time)", () => {
  it("a forecast built from a hydrated snapshot hit matches one built from the live batch on every value; only freshness/snapshot provenance differ", async () => {
    const ctx = await buildGoldenContext();
    const live = ctx.projections;
    const req = {
      league: { league_slug: "bloodline-bowl", season: 2026, raw_scoring: { rec: 0.5 }, scoring_rules: [] },
      week: 5,
      crosswalk: { version: "t" },
      canonical_player_ids: [...live.by_player.keys()],
    } as unknown as Parameters<typeof buildProjectionSnapshotArtifact>[0];
    const artifact = buildProjectionSnapshotArtifact(req, live);
    const hit = hydrateProjectionSnapshotBatch(artifact, req.canonical_player_ids, { observed_at: "2026-10-05T00:00:00.000Z", age_ms: 60_000, durable: true });
    const fromLive = buildCanonicalForecastBatch({ batch: live, requested_player_ids: req.canonical_player_ids });
    const fromHit = buildCanonicalForecastBatch({ batch: hit, requested_player_ids: req.canonical_player_ids });
    assert.equal(fromHit.by_player.size, fromLive.by_player.size);
    for (const [id, f] of fromLive.by_player) {
      const h = fromHit.by_player.get(id)!;
      assert.deepEqual(h.projection, f.projection, id);
      assert.equal(h.value_state, f.value_state, id);
      assert.equal(h.freshness.age_ms, 60_000);
      assert.equal(h.provenance.snapshot.read_path, "SUPABASE_HIT");
      assert.equal(h.provenance.source_ids.projection_snapshot_artifact_id, artifact.artifact_id);
    }
    // adding the forecast layer did not change the persisted artifact identity (no new rows/columns, hash stable)
    assert.equal(buildProjectionSnapshotArtifact(req, live).artifact_id, artifact.artifact_id);
  });
});

describe("W1.P1 diagnostics", () => {
  it("explainForecast answers the audit questions as machine-readable data", () => {
    const cand = shadowCandidate({ baseline: 14.6, xfp_forecast: 18, xfp_no_pressure: 17, p_absent: 0, confidence: "MEDIUM" });
    const f = build(row({ injury_status: "Questionable", expected_availability: 0.78 }), { shadow: { role: roleSignalFromShadowCandidate(cand) } });
    const d = explainForecast(f);
    assert.equal(d.source_points, 14.6);
    assert.equal(d.expected_points, f.projection.expected_points);
    assert.equal(d.expected_points_reason, "SOURCE_EMBEDS_PART_OF_INJURY_RISK_REMAINDER_APPLIED");
    assert.equal(d.is_bye, false);
    assert.equal(d.injury.source_status, "Questionable");
    assert.equal(d.injury.normalized_state, "QUESTIONABLE");
    assert.equal(d.injury.applied_to_expected_points, true);
    assert.deepEqual([d.role.available, d.role.mode, d.role.applied_to_expected_points], [true, "SHADOW", false]);
    assert.deepEqual([d.matchup.available, d.matchup.mode], [false, "NOT_APPLIED"]);
    assert.equal(d.provider, "sleeper_weekly");
    assert.equal(d.source_version, "sleeper-weekly-rotowire");
    assert.equal(d.model_version, CANONICAL_WEEKLY_FORECAST_VERSION);
    assert.deepEqual(d.invariant_violations, []);
  });
  it("invariant validator actually catches a promoted component and a drifted ledger", () => {
    const f = build(row());
    const promoted = structuredClone(f);
    promoted.role.mode = "PRODUCTION";
    assert.ok(validateForecastInvariants(promoted).includes("ROLE_PROMOTED"));
    const drift = structuredClone(f);
    drift.contributions.push({ component: "X", phenomenon: "ROLE", points_delta: 1, mode: "PRODUCTION" });
    const v = validateForecastInvariants(drift);
    assert.ok(v.some((x) => x.startsWith("LEDGER_SUM_")));
    assert.ok(v.includes("NON_BASE_PRODUCTION_CONTRIBUTION"));
    const dup = structuredClone(f);
    dup.contributions.push({ component: "BASE2", phenomenon: "BASE", points_delta: 0, mode: "PRODUCTION" });
    assert.ok(validateForecastInvariants(dup).includes("DUPLICATE_PRODUCTION_PHENOMENON_BASE"));
  });
});

describe("W1.P1 version stamping", () => {
  it("recommendation lineage records which forecast architecture produced the context", async () => {
    const ctx = await buildGoldenContext();
    assert.equal(ctx.lineage.engine_versions.canonical_weekly_forecast, "canonical-weekly-forecast-2026.1");
    assert.equal(ctx.forecasts!.model_version, ctx.lineage.engine_versions.canonical_weekly_forecast);
  });
});
