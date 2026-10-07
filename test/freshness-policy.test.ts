/**
 * W1.P4 freshness policy authority. Every test uses fixed instants and an injected clock: nothing here reads the wall clock.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FRESHNESS_POLICY_VERSION,
  INJURY_UNCERTAIN_CAPS,
  MIN_REQUIRED_MAX_AGE_MS,
  TIER_MAX_AGE_MS,
  evaluateForecastFreshness,
  requiredMaxAgeForBatch,
  requiredMaxAgeMs,
  tierFor,
} from "../lib/weekly/freshness/policy";
import { makeEvent } from "../lib/weekly/freshness/events";
import { nextKickoff, gameForTeam, type KickoffGame } from "../lib/weekly/freshness/kickoff";

const MIN = 60_000;
const H = 60 * MIN;
const KICK = Date.parse("2026-10-11T17:00:00.000Z"); // an early-Sunday kickoff instant
const at = (offsetMs: number) => new Date(KICK + offsetMs).toISOString();

const assess = (over: Partial<Parameters<typeof evaluateForecastFreshness>[0]> & { now_minus_kick: number; obs_minus_kick: number }) =>
  evaluateForecastFreshness({
    now_ms: KICK + over.now_minus_kick,
    kickoff_at: over.kickoff_at === undefined ? at(0) : over.kickoff_at,
    source_observed_at: over.source_observed_at === undefined ? at(over.obs_minus_kick) : over.source_observed_at,
    injury_uncertain: over.injury_uncertain,
    events: over.events,
    refresh: over.refresh,
  });

describe("W1.P4 dynamic freshness tiers (no universal 90-minute rule)", () => {
  it("tier boundaries", () => {
    assert.equal(tierFor(100 * H), "EARLY_WEEK");
    assert.equal(tierFor(72 * H), "MIDWEEK");
    assert.equal(tierFor(24 * H), "GAME_DAY_FAR");
    assert.equal(tierFor(6 * H), "GAME_DAY_NEAR");
    assert.equal(tierFor(90 * MIN), "FINAL_PREGAME");
    assert.equal(tierFor(15 * MIN), "KICKOFF_IMMINENT");
    assert.equal(tierFor(1), "KICKOFF_IMMINENT");
    assert.equal(tierFor(0), "GAME_STARTED");
    assert.equal(tierFor(-5 * MIN), "GAME_STARTED");
    assert.equal(tierFor(null), "KICKOFF_UNKNOWN");
  });

  it("requirement tightens monotonically as kickoff approaches", () => {
    const seq = [100 * H, 48 * H, 12 * H, 3 * H, 45 * MIN, 5 * MIN].map((t) => requiredMaxAgeMs(t).required!);
    for (let i = 1; i < seq.length; i++) assert.ok(seq[i]! <= seq[i - 1]!, `${seq[i - 1]} -> ${seq[i]}`);
    assert.equal(seq[0], TIER_MAX_AGE_MS.EARLY_WEEK);
    assert.equal(seq[5], TIER_MAX_AGE_MS.KICKOFF_IMMINENT);
    assert.ok(seq.every((v) => v >= MIN_REQUIRED_MAX_AGE_MS), "rate-protection floor");
  });

  it("early week: a 2h-old observation is fresh", () => {
    const r = assess({ now_minus_kick: -80 * H, obs_minus_kick: -82 * H });
    assert.equal(r.state, "FRESH");
    assert.equal(r.tier, "EARLY_WEEK");
  });

  it("game day, far from kickoff: a 40-minute-old observation is accepted", () => {
    const r = assess({ now_minus_kick: -10 * H, obs_minus_kick: -10 * H - 40 * MIN });
    assert.equal(r.tier, "GAME_DAY_FAR");
    assert.equal(r.state, "FRESH");
  });

  it("the SAME 2h age that is fine early in the week is stale near kickoff", () => {
    const early = assess({ now_minus_kick: -80 * H, obs_minus_kick: -82 * H });
    const near = assess({ now_minus_kick: -2 * H, obs_minus_kick: -4 * H });
    assert.equal(early.age_ms, near.age_ms);
    assert.equal(early.state, "FRESH");
    assert.equal(near.state, "STALE");
    assert.equal(near.reason, "AGE_EXCEEDS_REQUIRED");
  });

  it("very near kickoff: even 10 minutes is too old; 4 minutes is fine", () => {
    assert.equal(assess({ now_minus_kick: -10 * MIN, obs_minus_kick: -20 * MIN }).state, "STALE");
    assert.equal(assess({ now_minus_kick: -10 * MIN, obs_minus_kick: -14 * MIN }).state, "FRESH");
  });

  it("injury relevance tightens the requirement (never loosens it)", () => {
    const healthy = requiredMaxAgeMs(5 * H, false).required!;
    const doubtful = requiredMaxAgeMs(5 * H, true).required!;
    assert.ok(doubtful < healthy);
    assert.equal(doubtful, INJURY_UNCERTAIN_CAPS[0]!.max_age_ms);
    assert.ok(requiredMaxAgeMs(10 * MIN, true).required! <= requiredMaxAgeMs(10 * MIN, false).required!);
    assert.equal(assess({ now_minus_kick: -5 * H, obs_minus_kick: -5 * H - 25 * MIN, injury_uncertain: false }).state, "FRESH");
    assert.equal(assess({ now_minus_kick: -5 * H, obs_minus_kick: -5 * H - 25 * MIN, injury_uncertain: true }).state, "STALE");
  });

  it("unknown kickoff is conservative (never treated as far away)", () => {
    const r = assess({ now_minus_kick: -80 * H, obs_minus_kick: -80 * H - 45 * MIN, kickoff_at: null });
    assert.equal(r.tier, "KICKOFF_UNKNOWN");
    assert.equal(r.required_max_age_ms, TIER_MAX_AGE_MS.KICKOFF_UNKNOWN);
    assert.equal(r.state, "STALE");
  });

  it("unknown source observation time is UNKNOWN, never assumed fresh", () => {
    const r = assess({ now_minus_kick: -2 * H, obs_minus_kick: 0, source_observed_at: null });
    assert.equal(r.state, "UNKNOWN");
    assert.equal(r.reason, "SOURCE_OBSERVATION_TIME_UNKNOWN");
    assert.equal(r.age_ms, null);
  });
});

describe("W1.P4 event invalidation and refresh failure", () => {
  const ev = (knownAtOffset: number) => makeEvent({ type: "INJURY_STATUS_CHANGE", scope: { kind: "PLAYER", provider: "sleeper", provider_player_id: "1" }, effective_at: null, known_at: at(knownAtOffset), source: "sleeper", authority: "PROVIDER_STATUS", detail: { from: "Questionable", to: "Out" } });

  it("a newer event invalidates an otherwise perfectly fresh observation, regardless of age", () => {
    const fresh = assess({ now_minus_kick: -80 * H, obs_minus_kick: -80 * H - 1 * MIN });
    assert.equal(fresh.state, "FRESH");
    const inv = assess({ now_minus_kick: -80 * H, obs_minus_kick: -80 * H - 1 * MIN, events: [ev(-80 * H - 30_000)] });
    assert.equal(inv.state, "STALE");
    assert.equal(inv.reason, "INVALIDATED_BY_EVENT");
    assert.match(inv.invalidation_reasons[0]!, /^INJURY_STATUS_CHANGE:evt:/);
  });

  it("an event the observation already incorporates (known earlier) does not invalidate it", () => {
    const r = assess({ now_minus_kick: -80 * H, obs_minus_kick: -80 * H - 1 * MIN, events: [ev(-80 * H - 5 * MIN)] });
    assert.equal(r.state, "FRESH");
  });

  it("refresh success: a new observation is current", () => {
    const stale = assess({ now_minus_kick: -2 * H, obs_minus_kick: -4 * H });
    assert.equal(stale.state, "STALE");
    const refreshed = assess({ now_minus_kick: -2 * H, obs_minus_kick: -2 * H - 1 * MIN, refresh: { attempted: true, succeeded: true, failed_at: null, reason: null } });
    assert.equal(refreshed.state, "FRESH");
  });

  it("refresh FAILURE: the old observation is retained, clearly STALE, never presented as fresh", () => {
    const r = assess({ now_minus_kick: -2 * H, obs_minus_kick: -2 * H - 5 * MIN, refresh: { attempted: true, succeeded: false, failed_at: at(-2 * H), reason: "sleeper 503" } });
    assert.equal(r.state, "STALE");
    assert.equal(r.reason, "REFRESH_FAILED_LAST_KNOWN_RETAINED");
    assert.deepEqual(r.invalidation_reasons, ["REFRESH_FAILED"]);
    assert.equal(r.source_observed_at, at(-2 * H - 5 * MIN), "the last observation time is preserved, not refreshed");
    assert.match(r.user_warning!, /Latest refresh failed \(sleeper 503\); using the last known projection observed at/);
  });
});

describe("W1.P4 game start: the pregame forecast freezes", () => {
  it("after kickoff a pre-kickoff observation is FROZEN_PREGAME and needs no refresh", () => {
    const r = assess({ now_minus_kick: 5 * MIN, obs_minus_kick: -10 * MIN });
    assert.equal(r.state, "FROZEN_PREGAME");
    assert.equal(r.tier, "GAME_STARTED");
    assert.equal(r.required_max_age_ms, null);
  });

  it("an observation made AFTER kickoff is never a valid pregame forecast", () => {
    const r = assess({ now_minus_kick: 10 * MIN, obs_minus_kick: 5 * MIN });
    assert.equal(r.state, "UNKNOWN");
    assert.equal(r.reason, "POST_KICKOFF_OBSERVATION");
    assert.deepEqual(r.invalidation_reasons, ["OBSERVATION_AFTER_KICKOFF_NOT_A_VALID_PREGAME_FORECAST"]);
  });

  it("the instant of kickoff counts as started", () => {
    assert.equal(assess({ now_minus_kick: 0, obs_minus_kick: -30 * MIN }).state, "FROZEN_PREGAME");
  });
});

describe("W1.P4 user-facing warning semantics (machine fields beneath the prose)", () => {
  it("48 minutes old with kickoff in 18 minutes is outside the threshold", () => {
    const r = assess({ now_minus_kick: -18 * MIN, obs_minus_kick: -18 * MIN - 47 * MIN });
    assert.equal(r.state, "STALE");
    assert.equal(r.user_warning, "Projection last observed 47 min ago. Because kickoff is in 18 min, this forecast is outside the FINAL_PREGAME freshness threshold (15 min).");
    assert.equal(r.age_ms, 47 * MIN);
    assert.equal(r.required_max_age_ms, 15 * MIN);
  });

  it("11 minutes old with kickoff in 24 minutes satisfies the final-pregame requirement", () => {
    const r = assess({ now_minus_kick: -24 * MIN, obs_minus_kick: -24 * MIN - 11 * MIN });
    assert.equal(r.state, "FRESH");
    assert.equal(r.user_warning, null);
  });

  it("73 minutes old, kickoff in 16 minutes, refresh failed: stale with the failure stated", () => {
    const r = assess({ now_minus_kick: -16 * MIN, obs_minus_kick: -16 * MIN - 73 * MIN, refresh: { attempted: true, succeeded: false, failed_at: at(-16 * MIN), reason: "provider timeout" } });
    assert.equal(r.state, "STALE");
    assert.ok(r.user_warning!.includes("provider timeout"));
    assert.equal(r.age_ms, 73 * MIN);
  });
});

describe("W1.P4 absolute kickoff instants across time slots and offsets (no timezone assumption)", () => {
  const SLOTS: Array<[string, string]> = [
    ["Thursday night", "2026-10-15T00:15:00.000Z"],
    ["international (London 14:30 BST)", "2026-10-11T13:30:00.000Z"],
    ["early Sunday (1pm ET)", "2026-10-11T17:00:00.000Z"],
    ["late Sunday (4:25pm ET)", "2026-10-11T20:25:00.000Z"],
    ["Sunday night (8:20pm ET)", "2026-10-12T00:20:00.000Z"],
    ["Monday night (8:15pm ET)", "2026-10-13T00:15:00.000Z"],
  ];
  it("each slot: the same relative offsets produce the same tier — the clock is absolute", () => {
    for (const [, k] of SLOTS) {
      const kms = Date.parse(k);
      const r = evaluateForecastFreshness({ now_ms: kms - 20 * MIN, kickoff_at: k, source_observed_at: new Date(kms - 60 * MIN).toISOString() });
      assert.equal(r.tier, "FINAL_PREGAME", k);
      assert.equal(r.state, "STALE", k);
    }
  });
  it("the same instant written with different UTC offsets yields an identical assessment", () => {
    const z = evaluateForecastFreshness({ now_ms: Date.parse("2026-10-11T16:40:00Z"), kickoff_at: "2026-10-11T17:00:00.000Z", source_observed_at: "2026-10-11T16:30:00Z" });
    const et = evaluateForecastFreshness({ now_ms: Date.parse("2026-10-11T12:40:00-04:00"), kickoff_at: "2026-10-11T13:00:00-04:00", source_observed_at: "2026-10-11T12:30:00-04:00" });
    assert.equal(z.state, et.state);
    assert.equal(z.ms_to_kickoff, et.ms_to_kickoff);
    assert.equal(z.age_ms, et.age_ms);
  });
  it("a Thursday game freezes while the Sunday slate is still far away, and does not affect it", () => {
    const thu = Date.parse("2026-10-15T00:15:00.000Z");
    const sun = Date.parse("2026-10-18T17:00:00.000Z");
    const now = thu + 30 * MIN;
    assert.equal(evaluateForecastFreshness({ now_ms: now, kickoff_at: new Date(thu).toISOString(), source_observed_at: new Date(thu - 10 * MIN).toISOString() }).state, "FROZEN_PREGAME");
    assert.equal(evaluateForecastFreshness({ now_ms: now, kickoff_at: new Date(sun).toISOString(), source_observed_at: new Date(now - 1 * H).toISOString() }).state, "FRESH");
  });
});

describe("W1.P4 batch-level requirement and kickoff helpers", () => {
  const games: KickoffGame[] = [
    { game_id: "g1", home_team: "KC", away_team: "BUF", kickoff_at: at(-3 * H), status: "in_progress" },
    { game_id: "g2", home_team: "DAL", away_team: "NYG", kickoff_at: at(30 * MIN), status: "pre_game" },
    { game_id: "g3", home_team: "SF", away_team: "SEA", kickoff_at: at(3 * H), status: "pre_game" },
  ];
  it("the next NOT-YET-STARTED kickoff governs the league-wide snapshot", () => {
    const nk = nextKickoff(games, KICK);
    assert.equal(nk.next_kickoff_at, at(30 * MIN));
    const b = requiredMaxAgeForBatch({ now_ms: KICK, next_kickoff_at: nk.next_kickoff_at, kickoff_known: true, any_injury_uncertain: true });
    assert.equal(b.tier, "FINAL_PREGAME");
    assert.equal(b.required_max_age_ms, 15 * MIN);
  });
  it("kickoff unresolvable => conservative; all games finished => relaxed", () => {
    assert.equal(requiredMaxAgeForBatch({ now_ms: KICK, next_kickoff_at: null, kickoff_known: false }).tier, "KICKOFF_UNKNOWN");
    assert.equal(requiredMaxAgeForBatch({ now_ms: KICK, next_kickoff_at: null, kickoff_known: true }).tier, "EARLY_WEEK");
    assert.equal(nextKickoff(games.slice(0, 1), KICK).all_started, true);
  });
  it("games are associated by canonical team code regardless of provider spelling", () => {
    assert.equal(gameForTeam(games, "kc")?.game_id, "g1");
    assert.equal(gameForTeam(games, "NYG")?.game_id, "g2");
    assert.equal(gameForTeam(games, null), null);
    assert.equal(gameForTeam(games, "MIA"), null);
  });
  it("policy is versioned", () => assert.equal(FRESHNESS_POLICY_VERSION, "projection-freshness-2026.1"));
});
