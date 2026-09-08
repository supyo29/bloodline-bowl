/**
 * Sporty's Alumni — Draft Live safety (deterministic, no network).
 *
 * The draft is imminent. These guard the properties that could leave a drafted
 * player available or a manager on the wrong pick, and prove Draft Live is
 * independent of the Stage E/F published-snapshot system.
 *
 * NO recommendation-model code is changed. NO real Sleeper draft is mutated.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, afterEach } from "node:test";

import { findLeagueTarget, listLeagueTargets } from "../lib/leagues/registry";
import { resolveLeagueStrict } from "../lib/leagues/resolve";
import { selectActiveDraft } from "../lib/sleeper/draft";
import { computeDraftGeometry, overallPickNumber } from "../lib/bridge/geometry";
import { publishLeagueSnapshot } from "../lib/canonical/publish";
import { memoryPersistence } from "../lib/persistence/memory";
import { makeCanonicalSnapshot, stubProvider } from "./helpers/canonical-snapshot";
import type { RawDraft } from "../lib/sleeper/types";

const SLUG = "sportys-alumni";
const LEAGUE_ID = "1389404340015370240";
const DRAFT_ID = "1389404340032118784";
const TEAMS = 14;
const ROUNDS = 15;

const FLAG = "BRIDGE_PUBLISHED_SNAPSHOT";
afterEach(() => delete process.env[FLAG]);

const draft = (over: Partial<RawDraft> = {}): RawDraft =>
  ({
    draft_id: DRAFT_ID,
    league_id: LEAGUE_ID,
    status: "pre_draft",
    type: "snake",
    season: "2026",
    settings: { teams: TEAMS, rounds: ROUNDS, pick_timer: 60, reversal_round: 0 },
    slot_to_roster_id: {},
    draft_order: null,
    start_time: 1788904800000,
    last_picked: 0,
    metadata: {},
    created: 0,
    ...over,
  }) as RawDraft;

describe("Sporty's Alumni: registry resolves to the correct draft", () => {
  it("slug -> league id -> season", () => {
    const t = findLeagueTarget(SLUG);
    assert.ok(t);
    assert.equal(t.league_id, LEAGUE_ID);
    assert.equal(t.external_league_id, LEAGUE_ID);
    assert.equal(t.season, 2026);
    assert.equal(t.provider, "sleeper");
    const r = resolveLeagueStrict(SLUG);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.league.external_league_id, LEAGUE_ID);
  });

  it("no other configured league resolves to Sporty's Alumni id or draft", () => {
    const others = listLeagueTargets().filter((t) => t.key !== SLUG);
    for (const t of others) assert.notEqual(t.league_id, LEAGUE_ID);
    // a wrong slug does not fall back to Sporty's
    assert.equal(findLeagueTarget("sportys-alumnis"), null);
    const bb = resolveLeagueStrict("bloodline-bowl");
    assert.equal(bb.ok, true);
    assert.equal(bb.ok && bb.league.external_league_id, "1395549281678532608");
  });

  it("selectActiveDraft picks this league's own draft", () => {
    const chosen = selectActiveDraft([draft()]);
    assert.equal(chosen?.draft_id, DRAFT_ID);
    assert.equal(chosen?.type, "snake");
  });
});

describe("Sporty's Alumni: pre_draft -> drafting -> complete selection", () => {
  it("pre_draft: the upcoming draft is selected and identifiable", () => {
    const chosen = selectActiveDraft([draft({ status: "pre_draft" })]);
    assert.equal(chosen?.status, "pre_draft");
    assert.equal(chosen?.draft_id, DRAFT_ID);
  });

  it("drafting: an actively-running draft outranks a completed one", () => {
    const chosen = selectActiveDraft([
      draft({ draft_id: "old", status: "complete", season: "2025" }),
      draft({ status: "drafting" }),
    ]);
    assert.equal(chosen?.status, "drafting");
    assert.equal(chosen?.draft_id, DRAFT_ID);
  });

  it("complete: a finished draft is still readable when nothing is active", () => {
    const chosen = selectActiveDraft([draft({ status: "complete" })]);
    assert.equal(chosen?.status, "complete");
    assert.equal(chosen?.draft_id, DRAFT_ID);
  });
});

describe("Sporty's Alumni: 14-team snake geometry (drafted-player / pick correctness)", () => {
  it("snake reversal is correct for a 14-team draft", () => {
    // round 1 slot 7 -> pick 7; round 2 reverses -> 14*2 - 7 + 1 = 22; round 3 -> 14*2 + 7 = 35
    assert.equal(overallPickNumber(7, 1, TEAMS, "snake"), 7);
    assert.equal(overallPickNumber(7, 2, TEAMS, "snake"), 22);
    assert.equal(overallPickNumber(7, 3, TEAMS, "snake"), 35);
    // linear would NOT reverse
    assert.equal(overallPickNumber(7, 2, TEAMS, "linear"), 21);
  });

  it("a slot owns exactly `rounds` picks, strictly increasing, none repeated", () => {
    const geo = computeDraftGeometry({ slot: 5, teamCount: TEAMS, rounds: ROUNDS, overallPicksMade: 0, order: "snake" });
    const overalls = geo.all_picks.map((p) => p.overall);
    assert.equal(overalls.length, ROUNDS);
    assert.deepEqual([...overalls].sort((a, b) => a - b), overalls);
    assert.equal(new Set(overalls).size, ROUNDS);
    assert.ok(overalls.every((o) => o >= 1 && o <= TEAMS * ROUNDS));
  });

  it("'next pick' advances as the board fills — a manager is never stranded on a spent pick", () => {
    const before = computeDraftGeometry({ slot: 3, teamCount: TEAMS, rounds: ROUNDS, overallPicksMade: 0, order: "snake" });
    const after = computeDraftGeometry({ slot: 3, teamCount: TEAMS, rounds: ROUNDS, overallPicksMade: 3, order: "snake" });
    assert.equal(before.next_pick?.overall, 3);
    assert.equal(after.next_pick?.overall, TEAMS * 2 - 3 + 1); // round-2 pick, since pick 3 is spent
  });

  it("an impossible slot for a 14-team draft is rejected", () => {
    assert.throws(() => computeDraftGeometry({ slot: 15, teamCount: TEAMS, rounds: ROUNDS, overallPicksMade: 0, order: "snake" }));
  });
});

describe("Sporty's Alumni: Draft Live is independent of Stage E/F", () => {
  it("the draft-recommendation service imports NO published-snapshot / reader / flag code", () => {
    const src = readFileSync("lib/draft/service.ts", "utf8");
    for (const forbidden of [
      "canonical/read",
      "canonical/published",
      "published-flag",
      "getPublishedLeagueSnapshot",
      "readLeagueState",
      "bridge_published_snapshot",
      "publishLeagueSnapshot",
    ]) {
      assert.ok(!src.includes(forbidden), `lib/draft/service.ts must not reference "${forbidden}"`);
    }
  });

  it("the live draft client helpers exist and are no-store", () => {
    const src = readFileSync("lib/sleeper/client.ts", "utf8");
    assert.ok(src.includes("getDraftLive"));
    assert.ok(src.includes("getDraftPicksLive"));
    assert.ok(src.includes("getLeagueRostersLive"));
    assert.ok(/no-store/.test(src));
  });

  it("draft geometry + selectActiveDraft are pure — the Stage F flag cannot change them", () => {
    const noFlag = computeDraftGeometry({ slot: 7, teamCount: TEAMS, rounds: ROUNDS, overallPicksMade: 4, order: "snake" });
    process.env[FLAG] = "all";
    const withFlag = computeDraftGeometry({ slot: 7, teamCount: TEAMS, rounds: ROUNDS, overallPicksMade: 4, order: "snake" });
    assert.deepEqual(noFlag.all_picks, withFlag.all_picks);
    assert.equal(
      selectActiveDraft([draft({ status: "drafting" })])?.draft_id,
      DRAFT_ID,
    );
  });
});

describe("Sporty's Alumni: a pre_draft league is never published (no pointer to interfere)", () => {
  it("publishLeagueSnapshot on a pre_draft league -> skipped, no pointer, not a failure", async () => {
    const p = memoryPersistence();
    const snap = makeCanonicalSnapshot({ league_slug: SLUG, league_status: "pre_draft" });
    const r = await publishLeagueSnapshot(SLUG, {
      trigger: "CRON",
      buildOverride: async () => ({ ok: true, status: 200, snapshot: snap }),
      persistence: p,
    });
    assert.equal(r.outcome, "skipped");
    assert.equal(r.ok, true);
    assert.equal(r.http_status, 200);
    assert.equal(r.pointer_advanced, false);
    assert.equal(await p.published.get(SLUG, 2026), null);
  });

  it("a `drafting` league is also skipped", async () => {
    const p = memoryPersistence();
    const snap = makeCanonicalSnapshot({ league_slug: SLUG, league_status: "drafting" });
    const r = await publishLeagueSnapshot(SLUG, {
      trigger: "CRON",
      buildOverride: async () => ({ ok: true, status: 200, snapshot: snap }),
      persistence: p,
    });
    assert.equal(r.outcome, "skipped");
    assert.equal(await p.published.get(SLUG, 2026), null);
  });

  it("once in_season it publishes normally", async () => {
    const p = memoryPersistence();
    const snap = makeCanonicalSnapshot({ league_slug: SLUG, league_status: "in_season" });
    // reconcile needs teams — use the stub provider's default 2-team shape via override
    void stubProvider;
    const r = await publishLeagueSnapshot(SLUG, {
      trigger: "CRON",
      buildOverride: async () => ({ ok: true, status: 200, snapshot: snap }),
      persistence: p,
    });
    assert.equal(r.outcome, "published");
    assert.ok(await p.published.get(SLUG, 2026));
  });
});
