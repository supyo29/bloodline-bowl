/**
 * Sporty's Alumni Bridge profile — deterministic (no network).
 *
 * Registry §2/§7/§9/§10: the profile resolves, is manager-neutral (NO fake
 * self-manager), carries only verified config, does not reuse another league's
 * model, its 14-team snake geometry is correct, and the two existing profiles
 * are unchanged.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  findBridgeProfile,
  listBridgeProfiles,
  knownBridgeSelectors,
} from "../lib/bridge/profiles";
import { computeDraftGeometry, overallPickNumber } from "../lib/bridge/geometry";

const S = findBridgeProfile("sportys-alumni")!;
const BB = findBridgeProfile("bloodline_bowl")!;
const DM = findBridgeProfile("devoted_to_the_game")!;

describe("Sporty's Alumni profile: identity + resolution", () => {
  it("resolves by league_key, registry_key, and aliases", () => {
    assert.ok(findBridgeProfile("sportys_alumni"));
    assert.ok(findBridgeProfile("sportys-alumni"));
    assert.equal(findBridgeProfile("sportys")!.league_key, "sportys_alumni");
    assert.equal(findBridgeProfile("SPORTY")!.league_key, "sportys_alumni");
    assert.equal(findBridgeProfile("not-sportys"), null);
  });

  it("carries only verified Sleeper configuration", () => {
    assert.equal(S.platform_league_id, "1389404340015370240");
    assert.equal(S.platform_draft_id, "1389404340032118784");
    assert.equal(S.previous_league_id, "1255589856759775232");
    assert.equal(S.season, 2026);
    assert.equal(S.draft.type, "snake");
    assert.equal(S.draft.team_count, 14);
    assert.equal(S.draft.rounds, 15);
    assert.equal(S.draft.starts_at, "2026-09-08T22:00:00.000Z");
    assert.deepEqual(S.roster_rules.roster_positions, [
      "QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF",
      "BN", "BN", "BN", "BN", "BN",
    ]);
    assert.deepEqual(S.roster_rules.flex_positions, ["RB", "WR", "TE"]);
  });

  it("is MANAGER-NEUTRAL — no fabricated self-manager", () => {
    assert.equal(S.manager, null);
    assert.equal(S.manager_neutral, true);
    // no Sporty's member name hard-coded as an owner anywhere in the profile
    const json = JSON.stringify(S);
    for (const name of ["rspata2", "dusty22k", "battmurwinkle", "supyo29", "darthmarker"]) {
      assert.ok(!json.includes(`"manager_key":"${name}"`), `no ${name} as manager_key`);
    }
  });

  it("does NOT reuse another league's model / rankings / scoring", () => {
    assert.equal(S.ranking_pack_id, null);
    assert.equal(S.model.candidate_id, null);
    assert.equal(S.model.candidate_source, "none");
    assert.equal(S.model.survival_engine, null);
    assert.equal(S.model.default_ranking_source, "sleeper_search_rank");
    const json = JSON.stringify(S);
    assert.ok(!/bloodline/i.test(json));
    assert.ok(!/darthmarker/i.test(json));
    assert.ok(!json.includes("bloodline_production_20260827113702"));
    assert.ok(!json.includes("rosterintel_mark_darthmarker_v7"));
  });
});

describe("Sporty's Alumni: 14-team snake geometry matches Sleeper", () => {
  // Sleeper draft 1389404340032118784: 14 teams, 15 rounds, snake, reversal_round 0.
  it("early picks and round boundaries", () => {
    assert.equal(overallPickNumber(1, 1, 14, "snake"), 1);
    assert.equal(overallPickNumber(14, 1, 14, "snake"), 14);
    // round 2 reverses: slot 14 picks 15, slot 1 picks 28
    assert.equal(overallPickNumber(14, 2, 14, "snake"), 15);
    assert.equal(overallPickNumber(1, 2, 14, "snake"), 28);
    // round 3 back to slot order: slot 1 picks 29, slot 14 picks 42
    assert.equal(overallPickNumber(1, 3, 14, "snake"), 29);
    assert.equal(overallPickNumber(14, 3, 14, "snake"), 42);
    // a later boundary — round 8→9
    assert.equal(overallPickNumber(7, 8, 14, "snake"), 14 * 7 + (14 - 7 + 1)); // 106
    assert.equal(overallPickNumber(7, 9, 14, "snake"), 14 * 8 + 7); // 119
  });

  it("a slot owns exactly 15 strictly-increasing unique picks in range", () => {
    for (const slot of [1, 7, 14]) {
      const geo = computeDraftGeometry({ slot, teamCount: 14, rounds: 15, overallPicksMade: 0, order: "snake" });
      const o = geo.all_picks.map((p) => p.overall);
      assert.equal(o.length, 15);
      assert.deepEqual([...o].sort((a, b) => a - b), o);
      assert.equal(new Set(o).size, 15);
      assert.ok(o.every((x) => x >= 1 && x <= 210));
    }
  });

  it("linear would NOT reverse (proves snake is applied)", () => {
    assert.equal(overallPickNumber(1, 2, 14, "linear"), 15);
    assert.notEqual(overallPickNumber(1, 2, 14, "linear"), overallPickNumber(1, 2, 14, "snake"));
  });

  it("impossible slot for a 14-team draft is rejected", () => {
    assert.throws(() => computeDraftGeometry({ slot: 15, teamCount: 14, rounds: 15, overallPicksMade: 0, order: "snake" }));
  });
});

describe("existing Bridge profiles are regression-stable", () => {
  it("exactly 3 profiles; selectors are the three league keys", () => {
    assert.equal(listBridgeProfiles().length, 3);
    assert.deepEqual(knownBridgeSelectors(), ["bloodline_bowl", "devoted_to_the_game", "sportys_alumni"]);
  });

  it("Bloodline Bowl unchanged", () => {
    assert.equal(BB.manager_neutral, false);
    assert.equal(BB.manager!.manager_key, "supyo29");
    assert.equal(BB.manager!.sleeper_user_id, "1308955807408230400");
    assert.equal(BB.manager!.draft_slot, 7);
    assert.equal(BB.platform_league_id, "1395549281678532608");
    assert.equal(BB.ranking_pack_id, null);
    assert.equal(BB.model.candidate_id, "bloodline_production_20260827113702");
    assert.equal(BB.draft.team_count, 12);
  });

  it("Devoted to the Game unchanged", () => {
    assert.equal(DM.manager_neutral, false);
    assert.equal(DM.manager!.manager_key, "darthmarker");
    assert.equal(DM.manager!.draft_slot, 4);
    assert.equal(DM.ranking_pack_id, "darthmarker_2026");
    assert.equal(DM.opponent_modeling.exclude_own_historical_profile, true);
    assert.equal(DM.draft.rounds, 16);
  });

  it("no league's platform ids collide", () => {
    const ids = listBridgeProfiles().flatMap((p) => [p.platform_league_id, p.platform_draft_id]);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("DraftPoller reuse — the /bridge page imports the shared poller", () => {
  it("app/bridge/page.tsx uses DraftPoller from lib/bridge/draft-poller, not a bespoke loop", async () => {
    const src = (await import("node:fs")).readFileSync("app/bridge/page.tsx", "utf8");
    assert.ok(src.includes('from "@/lib/bridge/draft-poller"'));
    assert.ok(src.includes("new DraftPoller("));
    // no Sporty-specific polling
    assert.ok(!src.includes("sportysPoll"));
    assert.ok(!/setInterval\(/.test(src), "no ad-hoc setInterval in the page");
  });
});
