/**
 * End-to-end tests for `GET /api/draft` against the real Bloodline Bowl league.
 * Requires network access.
 *
 * The league is pre-draft, so these assert the invariants that must hold in any
 * draft state plus the specific guarantees of the pre-draft response.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import {
  DEFAULT_AVAILABLE_LIMIT,
  buildDraftBundle,
} from "../lib/sleeper/draft-service";
import { BLOODLINE_BOWL_LEAGUE_ID } from "../lib/sleeper/service";
import type { DraftResponse } from "../lib/sleeper/types";

let response: DraftResponse;
let cacheSeconds: number;

before(async () => {
  const bundle = await buildDraftBundle(BLOODLINE_BOWL_LEAGUE_ID, {
    availableLimit: DEFAULT_AVAILABLE_LIMIT,
    position: null,
  });
  response = bundle.response;
  cacheSeconds = bundle.cacheSeconds;
});

describe("live draft snapshot", () => {
  it("loads every resource without warnings", () => {
    assert.deepEqual(response.metadata.warnings, []);
  });

  it("selects the league's actual draft", () => {
    assert.ok(response.draft, "expected a draft");
    assert.equal(response.draft.season, "2026");
    assert.ok(response.draft.draft_id.length > 0);
  });

  it("identifies the draft as an auction with a real budget", () => {
    assert.equal(response.draft?.type, "auction");
    assert.equal(response.budget.supported, true);
    assert.equal(response.budget.starting_budget_per_team, 200);
    assert.equal(response.budget.source, "sleeper_pick_metadata");
    // Sleeper exposes no minimum-bid setting, so this must be labelled assumed.
    assert.equal(response.budget.minimum_bid_source, "assumed_default");
  });

  it("represents all ten managers", () => {
    assert.equal(response.teams.length, 10);
    assert.equal(response.metadata.team_count, 10);
    assert.deepEqual(
      response.teams.map((team) => team.roster_id),
      Array.from({ length: 10 }, (_, index) => index + 1),
    );
  });

  it("gives every team a distinct draft slot", () => {
    const slots = response.teams
      .map((team) => team.draft_slot)
      .filter((slot): slot is number => slot !== null);
    assert.equal(slots.length, 10);
    assert.equal(new Set(slots).size, 10, "draft slots must be unique");
  });

  it("resolves claimed rosters to their manager names", () => {
    const claimed = response.teams.filter((team) => !team.manager.is_vacant);
    assert.ok(claimed.length > 0);
    for (const team of claimed) {
      assert.ok(team.manager.user_id, `roster ${team.roster_id} user_id`);
      assert.ok(
        team.manager.display_name,
        `roster ${team.roster_id} display_name`,
      );
    }
  });

  it("keeps every team's budget arithmetic self-consistent", () => {
    for (const team of response.teams) {
      const budget = team.budget;
      assert.ok(budget, `roster ${team.roster_id} should have a budget`);
      assert.equal(budget.starting - budget.spent, budget.remaining);
      assert.ok(budget.maximum_single_bid >= 0);
      assert.ok(budget.maximum_single_bid <= budget.remaining);
      assert.equal(
        team.roster.slots_remaining,
        Math.max(0, team.roster.slots_required - team.roster.players_acquired),
      );
    }
  });

  it("never lets a max bid strand a roster below its remaining slots", () => {
    for (const team of response.teams) {
      const budget = team.budget;
      assert.ok(budget);
      const leftover = budget.remaining - budget.maximum_single_bid;
      const slotsAfterBid = Math.max(0, team.roster.slots_remaining - 1);
      assert.ok(
        leftover >= slotsAfterBid * response.budget.minimum_bid,
        `roster ${team.roster_id} could not fill its remaining slots`,
      );
    }
  });

  it("excludes drafted and rostered players from the available pool", () => {
    const drafted = new Set(
      response.picks
        .map((pick) => pick.player?.player_id)
        .filter((id): id is string => Boolean(id)),
    );
    for (const player of response.available_players) {
      assert.ok(!drafted.has(player.player_id));
    }
  });

  it("returns a bounded, resolved available pool", () => {
    const { available_players: meta } = response.metadata;
    assert.equal(meta.limit, DEFAULT_AVAILABLE_LIMIT);
    assert.equal(response.available_players.length, meta.returned);
    assert.ok(meta.returned <= meta.limit);
    assert.ok(
      meta.total_matching > meta.returned,
      "the pool should be larger than what is returned",
    );
    for (const player of response.available_players) {
      assert.equal(player.resolved, true);
      assert.ok(player.full_name.length > 0);
    }
  });

  it("includes a candidate for every required starting position", () => {
    const positions = new Set(
      response.available_players.flatMap((p) => p.fantasy_positions),
    );
    for (const required of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
      assert.ok(
        positions.has(required),
        `no available candidate for required position ${required}`,
      );
    }
  });

  it("does not ship the whole player database", () => {
    assert.ok(response.metadata.player_database_size > 10_000);
    const bytes = Buffer.byteLength(JSON.stringify(response));
    assert.ok(bytes < 500_000, `payload too large: ${bytes} bytes`);
  });

  it("reports a market view consistent with the teams", () => {
    const maxBids = response.teams.map(
      (team) => team.budget?.maximum_single_bid ?? 0,
    );
    assert.equal(response.market.largest_max_bid, Math.max(...maxBids));
    const remaining = response.teams.map((team) => team.budget?.remaining ?? 0);
    assert.equal(
      response.market.highest_remaining_budget,
      Math.max(...remaining),
    );
    assert.equal(
      response.market.lowest_remaining_budget,
      Math.min(...remaining),
    );
    assert.ok(response.market.top_bidders.length > 0);
  });

  it("is fresh enough to poll during a live draft", () => {
    assert.equal(response.metadata.polling_safe, true);
    assert.equal(response.metadata.cache_seconds, cacheSeconds);
    assert.ok(cacheSeconds <= 30, `cache too long: ${cacheSeconds}s`);
    assert.ok(!Number.isNaN(Date.parse(response.generated_at)));
  });
});

describe("live draft: pre-draft state", () => {
  it("reports the pre-draft status without treating it as an error", () => {
    assert.equal(response.draft?.status, "pre_draft");
    assert.equal(response.draft?.completed_picks, 0);
    assert.equal(response.picks.length, 0);
    assert.equal(response.last_pick, null);
  });

  it("gives every team a full budget and an empty roster", () => {
    for (const team of response.teams) {
      assert.equal(team.budget?.spent, 0);
      assert.equal(team.budget?.remaining, 200);
      assert.equal(team.roster.players_acquired, 0);
      assert.equal(team.roster.slots_remaining, team.roster.slots_required);
      assert.deepEqual(team.positions, {});
    }
  });

  it("reports the full starting lineup as still needed", () => {
    for (const team of response.teams) {
      const required = Object.fromEntries(
        team.needs.required.map((n) => [n.position, n.minimum_needed]),
      );
      assert.deepEqual(required, {
        QB: 2,
        RB: 2,
        WR: 2,
        TE: 1,
        K: 1,
        DEF: 1,
      });
      assert.equal(team.needs.flexible_slots_remaining, 2);
    }
  });

  it("leaves prices_available null when there is nothing to judge", () => {
    assert.equal(response.budget.prices_available, null);
    assert.equal(response.budget.picks_missing_price, 0);
  });
});

describe("live draft: query handling", () => {
  it("honours a position filter end to end", async () => {
    const { response: filtered } = await buildDraftBundle(
      BLOODLINE_BOWL_LEAGUE_ID,
      { availableLimit: 25, position: "TE" },
    );
    assert.equal(filtered.available_players.length, 25);
    assert.equal(filtered.metadata.available_players.position_filter, "TE");
    for (const player of filtered.available_players) {
      assert.ok(player.fantasy_positions.includes("TE"));
    }
  });

  it("honours a smaller available_limit", async () => {
    const { response: small } = await buildDraftBundle(
      BLOODLINE_BOWL_LEAGUE_ID,
      { availableLimit: 10, position: null },
    );
    assert.equal(small.available_players.length, 10);
    assert.equal(small.metadata.available_players.limit, 10);
  });
});
