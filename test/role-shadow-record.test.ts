/**
 * W2.P2 — capture record: point-in-time rules, evidence classes, identity, scoring compatibility, tamper detection.
 * Critical rule under test: NO information first observed at or after the applicable kickoff may influence a pregame capture.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildLeagueWeekRecords } from "../lib/role-shadow/capture";
import { buildRecord, derivePopulation, pointInTimeViolations, validateRecord, withIds, type RoleShadowRecord } from "../lib/role-shadow/record";
import { assessScoring } from "../lib/role-shadow/scoring";
import { PINNED } from "../lib/role-shadow/spec";
import { BB_SCORING, DAY, HOUR, KICK, MIN, NOW, PPR_SCORING, champion, iso, leagueWeek, liveRecord, roleForecast } from "./fixtures/role-shadow";

const build = (champ = {}, role = {}, now = NOW, league = {}) => buildLeagueWeekRecords(leagueWeek([champion(champ)], league), [roleForecast(role)], now, "TEST");

describe("point-in-time: every instant must be strictly before the player's kickoff", () => {
  it("a valid pregame capture is built and validates; time ordering is observed <= composed <= captured", () => {
    const r = liveRecord();
    assert.equal(r.capture_class, "LIVE_CAPTURED");
    assert.deepEqual(validateRecord(r), []);
    assert.ok(Date.parse(r.timing.source_observed_at!) <= Date.parse(r.timing.forecast_composed_at!));
    assert.ok(Date.parse(r.timing.forecast_composed_at!) <= Date.parse(r.timing.captured_at));
    assert.ok(Date.parse(r.timing.captured_at) < Date.parse(r.game.kickoff_at!));
  });

  for (const [label, run] of [
    ["capture at the kickoff instant (not strictly before)", () => build({}, {}, KICK)],
    ["capture after kickoff", () => build({}, {}, KICK + MIN)],
    ["source observation AT kickoff (a fetch that began before kickoff but arrived at it is not pregame evidence)", () => build({ observed_ms: KICK, composed_ms: KICK - MIN })],
    ["source observation after kickoff", () => build({ observed_ms: KICK + 5 * MIN, composed_ms: KICK + 6 * MIN })],
    ["forecast composed after kickoff", () => build({ observed_ms: NOW - HOUR, composed_ms: KICK + MIN })],
    ["Role forecast frozen after kickoff", () => build({}, { as_of_ms: KICK + MIN })],
    ["Role input data cutoff after kickoff (a completed-game instant later than the player's own kickoff)", () => build({}, { cutoff_ms: KICK + HOUR })],
  ] as const) {
    it(`REJECTS (no record, no class): ${label}`, () => {
      const r = run();
      assert.equal(r.records.length, 0);
      assert.equal(r.counters.built, 0);
      assert.equal(r.counters.rejected_late + r.counters.rejected_incoherent, 1, JSON.stringify(r.counters));
    });
  }

  it("REJECTS an incoherent timeline: source observation AFTER forecast composition", () => {
    const r = build({ observed_ms: NOW - MIN, composed_ms: NOW - 10 * MIN });
    assert.equal(r.records.length, 0);
    assert.equal(r.counters.rejected_incoherent, 1);
  });

  it("REJECTS a forecast composed AFTER the capture time, and a Role forecast frozen after the capture", () => {
    assert.equal(build({ composed_ms: NOW + MIN, observed_ms: NOW }).records.length, 0);
    assert.equal(build({}, { as_of_ms: NOW + MIN }).records.length, 0);
  });

  it("REJECTS a capture with no resolvable kickoff (cannot be proven pregame) — counted separately, never guessed", () => {
    const r = build({ kickoff_ms: null }, { kickoff_ms: null });
    assert.equal(r.records.length, 0);
    assert.equal(r.counters.rejected_no_kickoff, 1);
  });

  it("kickoff is the EARLIEST of the champion clock and the Role clock — a disagreement can only make the cutoff stricter", () => {
    const early = KICK - 3 * HOUR;
    const r = build({}, { kickoff_ms: early }).records[0]!;
    assert.equal(r.game.kickoff_at, iso(early));
    assert.equal(r.game.kickoff_basis, "MIN_OF_CHAMPION_AND_ROLE");
    // a capture made between the two clocks is rejected because the stricter kickoff has passed
    assert.equal(build({}, { kickoff_ms: early }, early + MIN).records.length, 0);
    // a missing clock on one side falls back to the other, and is labeled
    assert.equal(build({ kickoff_ms: null }, {}).records[0]!.game.kickoff_basis, "ROLE_ONLY");
    assert.equal(build({}, { kickoff_ms: null }).records[0]!.game.kickoff_basis, "CHAMPION_ONLY");
  });

  it("per-player clock: a capture is late for the early game but still valid for a later game in the same week", () => {
    const early = champion({ id: "pA", sleeper_id: "sA", gsis_id: "00-A", kickoff_ms: KICK - 5 * HOUR });
    const late = champion({ id: "pB", sleeper_id: "sB", gsis_id: "00-B", kickoff_ms: KICK + 4 * HOUR });
    const roles = [roleForecast({ gsis: "00-A", sleeper: "sA", kickoff_ms: KICK - 5 * HOUR }), roleForecast({ gsis: "00-B", sleeper: "sB", kickoff_ms: KICK + 4 * HOUR, id: "rf:bbbbbbbbbbbbbbbbbbbbbbbb" })];
    const r = buildLeagueWeekRecords(leagueWeek([early, late]), roles, KICK - 2 * HOUR, "TEST");
    assert.deepEqual(r.records.map((x) => x.player.gsis_id), ["00-B"]);
    assert.equal(r.counters.rejected_late, 1);
  });

  it("pointInTimeViolations() is independent of the builder: a hand-edited late timestamp on a stored record is caught by validation", () => {
    const r = liveRecord();
    const bad = withIds({ ...stripIds(r), timing: { ...r.timing, source_observed_at: r.game.kickoff_at } });
    assert.ok(validateRecord(bad).some((x) => /source_observed_at .* not strictly before kickoff/.test(x)), validateRecord(bad).join("; "));
    assert.ok(pointInTimeViolations(bad).length > 0);
  });
});

const stripIds = (r: RoleShadowRecord) => { const { capture_id: _a, content_hash: _b, ...rest } = r; void _a; void _b; return rest; };

describe("evidence classes: reconstructed never counts; live requires a live Role forecast", () => {
  it("a Role forecast labeled AS_OF_RECONSTRUCTION yields HISTORICALLY_RECONSTRUCTED: never eligible, never covered", () => {
    const r = build({}, { kind: "AS_OF_RECONSTRUCTION" }).records[0]!;
    assert.equal(r.capture_class, "HISTORICALLY_RECONSTRUCTED");
    assert.equal(r.population.eligible, false);
    assert.equal(r.population.covered, false);
    assert.ok(r.population.reasons.includes("CLASS_HISTORICALLY_RECONSTRUCTED_NEVER_ELIGIBLE"));
    assert.deepEqual(validateRecord(r), []);
  });

  it("relabeling attacks fail validation: a reconstructed record cannot be promoted to LIVE_CAPTURED, nor a live one demoted-then-eligible", () => {
    const rec = build({}, { kind: "AS_OF_RECONSTRUCTION" }).records[0]!;
    const promoted = withIds({ ...stripIds(rec), capture_class: "LIVE_CAPTURED" });
    assert.ok(validateRecord(promoted).some((x) => /LIVE_CAPTURED requires a live-frozen Role forecast/.test(x)));
    const live = liveRecord();
    const demoted = withIds({ ...stripIds(live), capture_class: "HISTORICALLY_RECONSTRUCTED" });
    assert.ok(validateRecord(demoted).some((x) => /(non-live record can never be population-eligible|reconstructed record cannot carry a live Role forecast)/.test(x)));
  });

  it("the record can never influence production: lifecycle SHADOW_ONLY and may_influence_production=false are validated", () => {
    const live = liveRecord();
    assert.equal(live.lifecycle_state, "SHADOW_ONLY");
    assert.equal(live.may_influence_production, false);
    const bad = withIds({ ...stripIds(live), may_influence_production: true as unknown as false });
    assert.ok(validateRecord(bad).some((x) => /SHADOW_ONLY and non-influencing/.test(x)));
  });
});

describe("content-addressed identity", () => {
  it("re-capturing identical evidence at a later time yields the SAME id (idempotent); capture/composition time and provenance are not identity", () => {
    const a = build({ composed_ms: NOW - 5 * MIN }, { as_of_ms: NOW }, NOW).records[0]!;
    const b = build({ composed_ms: NOW - 1 * MIN }, { as_of_ms: NOW + 30 * MIN }, NOW + 30 * MIN).records[0]!;
    assert.equal(a.capture_id, b.capture_id);
    assert.equal(a.content_hash, b.content_hash);
    assert.notEqual(a.timing.captured_at, b.timing.captured_at);
  });

  it("any change of evidence is a NEW record: projection, injury status, Role confidence, Role features, source observation, scoring, league", () => {
    const base = liveRecord().capture_id;
    const variants = [
      liveRecord({ points: 15.1 }), liveRecord({ injury_status: "Questionable" }), liveRecord({}, { confidence: "LOW" }),
      liveRecord({}, { overrides: { opportunity: { carries: null, rz_carries: null, targets: 8.1, rz_targets: 0.9, dropbacks: null, designed_rushes: null, scrambles: null } } }),
      liveRecord({ observed_ms: NOW - 2 * HOUR }), liveRecord({}, {}, { raw_scoring: { ...BB_SCORING, rec_yd: 0.2 } }), liveRecord({}, {}, { league_slug: "other-league" }),
    ].map((r) => r.capture_id);
    assert.equal(new Set([base, ...variants]).size, variants.length + 1, "every variant must have a distinct id");
  });

  it("a different MODEL VERSION is a different record and is refused by validation if its config hash is not the pinned frozen one", () => {
    const r = liveRecord();
    const other = withIds({ ...stripIds(r), models: { ...r.models, challenger: { ...r.models.challenger, config_hash: "0".repeat(32) } } });
    assert.notEqual(other.capture_id, r.capture_id);
    assert.ok(validateRecord(other).some((x) => /not the pinned frozen configuration/.test(x)));
    assert.equal(r.models.challenger.config_hash, PINNED.challenger_config_hash);
  });

  it("TAMPER: editing a stored number without re-hashing fails the content check; editing it WITH re-hashing fails arm reproducibility", () => {
    const r = liveRecord();
    const edited = structuredClone(r);
    edited.champion.expected_points = 99;
    assert.ok(validateRecord(edited).some((x) => /content_hash does not match/.test(x)));
    const rehashed = withIds({ ...stripIds(r), arms: { ...r.arms, challenger: { ...r.arms.challenger, delta: 5, expected_points: 19.6 } } });
    assert.ok(validateRecord(rehashed).some((x) => /arms are not reproducible/.test(x)), validateRecord(rehashed).join("; "));
  });
});

describe("league-scoring compatibility with the frozen HALF fit", () => {
  it("every modeled rule equal => compatible (Bloodline Bowl style), with the unmodeled offensive rules listed, not silently ignored", () => {
    const a = assessScoring(BB_SCORING);
    assert.equal(a.compatibility, "TEMPLATE_HALF_ON_MODELED_KEYS");
    assert.deepEqual(a.deviations, []);
    assert.deepEqual(a.unmodeled_offense_keys, ["fum_rec", "pass_int_td", "pass_sack"]);
  });

  it("PPR or a -1 interception is NOT on the frozen fit: no silent league-scoring transformation", () => {
    const a = assessScoring(PPR_SCORING);
    assert.equal(a.compatibility, "NO_FROZEN_FIT");
    assert.deepEqual(a.deviations.map((d) => d[0]).sort(), ["pass_int", "rec"]);
    assert.equal(assessScoring({ ...BB_SCORING, pass_td: 6 }).compatibility, "NO_FROZEN_FIT");
    assert.equal(assessScoring({ ...BB_SCORING, rec_yd: 0.2 }).compatibility, "NO_FROZEN_FIT");
    assert.equal(assessScoring(null).compatibility, "SCORING_UNAVAILABLE");
    assert.equal(assessScoring({}).compatibility, "SCORING_UNAVAILABLE");
  });

  it("an incompatible league's capture is stored for coverage reporting but is NEVER population-eligible", () => {
    const r = liveRecord({}, {}, { raw_scoring: PPR_SCORING });
    assert.equal(r.population.eligible, false);
    assert.ok(r.population.reasons.includes("SCORING_NO_FROZEN_FIT"));
    assert.equal(r.scoring.template, null);
    assert.deepEqual(validateRecord(r), []);
  });
});

describe("population rules (reconstructed R-P1)", () => {
  const pop = (over: Partial<Parameters<typeof derivePopulation>[0]> = {}) => derivePopulation({ capture_class: "LIVE_CAPTURED", position: "WR", scoring: "TEMPLATE_HALF_ON_MODELED_KEYS", join_ok: true, conditional_active_points: 9, expected_points: 9, value_state: "PROJECTED", arms_state: "APPLIED", ...over });

  it("eligible/headline/covered/tier follow the pre-registered population", () => {
    assert.deepEqual(pop(), { eligible: true, headline: true, covered: true, tier: "FLEX", reasons: [] });
    assert.equal(pop({ conditional_active_points: 12 }).tier, "STARTER");
    assert.equal(pop({ conditional_active_points: 5.99 }).tier, "FRINGE");
  });

  it("excluded: below the 3.0 relevance floor, bye / no game, no baseline, K/DST, non-template scoring, unproven identity", () => {
    assert.ok(pop({ conditional_active_points: 2.99 }).reasons.includes("BELOW_RELEVANCE_FLOOR"));
    assert.ok(pop({ value_state: "BYE_VERIFIED" }).reasons.includes("NO_GAME_THIS_WEEK_SCHEDULE_KNOWN"));
    assert.ok(pop({ conditional_active_points: null, expected_points: null }).reasons.includes("NO_CHAMPION_BASELINE"));
    assert.ok(pop({ position: "K" }).reasons.includes("POSITION_NOT_APPLICABLE_K_DST"));
    assert.ok(pop({ position: "DST" }).reasons.includes("POSITION_NOT_APPLICABLE_K_DST"));
    assert.ok(pop({ join_ok: false }).reasons.includes("PLAYER_IDENTITY_JOIN_NOT_PROVEN"));
  });

  it("known-unavailable stays in the population (to prove the contribution is exactly 0) but is not headline and not covered", () => {
    const p = pop({ arms_state: "NEUTRAL_UNAVAILABLE" });
    assert.equal(p.eligible, true);
    assert.equal(p.headline, false);
    assert.equal(p.covered, false);
  });

  it("real builder path: an OUT player is captured with all three arms exactly 0; a bye player is not eligible", () => {
    const out = liveRecord({ injury_status: "Out", points: 11 });
    assert.equal(out.arms.shared_state, "NEUTRAL_UNAVAILABLE");
    for (const a of [out.arms.challenger, out.arms.control, out.arms.c2_full]) assert.equal(a.delta, 0);
    assert.equal(out.champion.expected_points, 0);
    const bye = liveRecord({ is_bye: true, points: null });
    assert.equal(bye.population.eligible, false);
  });

  it("buildRecord() with a late candidate returns reasons and NO record (the API cannot mint a late LIVE_CAPTURED row)", () => {
    const ok = liveRecord();
    const res = buildRecord({
      capture_class: "LIVE_CAPTURED", captured_at: iso(KICK + DAY), invocation: "TEST", season: 2026, week: 6, league_slug: "bloodline-bowl", provider: "sleeper",
      player: ok.player, game: ok.game, timing: { source_observed_at: ok.timing.source_observed_at, forecast_composed_at: ok.timing.forecast_composed_at, role_as_of_at: ok.timing.role_as_of_at, role_data_cutoff_at: ok.timing.role_data_cutoff_at },
      scoring_fingerprint: ok.scoring.fingerprint, raw_scoring: BB_SCORING, champion: ok.champion, role: ok.role, lineage: ok.lineage,
    });
    assert.equal(res.record, null);
    assert.ok(res.rejected.some((x) => /captured_at .* not strictly before kickoff/.test(x)));
  });
});

describe("player identity join (no crosswalk repair; conflicts fail closed)", () => {
  const run = (champ: object, roles: ReturnType<typeof roleForecast>[]) => buildLeagueWeekRecords(leagueWeek([champion(champ)]), roles, NOW, "TEST");

  it("joins on gsis when both carry it", () => {
    assert.equal(run({}, [roleForecast()]).records[0]!.player.join_method, "GSIS");
  });
  it("falls back to the Role profile's own sleeper id when the canonical player has no gsis (crosswalk gap), labeled as such", () => {
    const r = run({ gsis_id: null }, [roleForecast()]);
    assert.equal(r.records[0]!.player.join_method, "SLEEPER_ID_VIA_PROFILE");
    assert.equal(r.records[0]!.player.gsis_id, "00-0001", "the gsis id is taken from the Role profile, not invented");
  });
  it("an ambiguous sleeper id (two Role profiles) is skipped and counted, never guessed", () => {
    const r = run({ gsis_id: null }, [roleForecast({ gsis: "00-A" }), roleForecast({ gsis: "00-B" })]);
    assert.equal(r.records.length, 0);
    assert.equal(r.counters.ambiguous_identity, 1);
  });
  it("no Role forecast for the player: counted, not fabricated", () => {
    const r = run({}, [roleForecast({ gsis: "00-ZZ", sleeper: "sZZ" })]);
    assert.equal(r.counters.no_role_forecast, 1);
  });
  it("a team or position disagreement between the champion and the Role forecast is an identity conflict and is skipped (temporal-identity safe)", () => {
    assert.equal(run({}, [roleForecast({ team: "BUF" })]).counters.identity_conflict, 1);
    assert.equal(run({}, [roleForecast({ position: "TE" })]).counters.identity_conflict, 1);
  });
  it("K / DST and other non-skill positions are not applicable", () => {
    const r = buildLeagueWeekRecords(leagueWeek([champion({ position: "K", id: "pk" })]), [roleForecast()], NOW, "TEST");
    assert.equal(r.counters.not_applicable_position, 1);
  });
});
