/**
 * Pre-draft guarantees of the draft bundle — HERMETIC. These four assertions used to live in test/draft-live.test.ts behind `if (!isPreDraft()) t.skip(...)`, so once the real draft
 * completed they could never run again. Here the Sleeper API is a fetch router over the committed fixtures with the draft forced to `pre_draft`, for both a snake and an auction draft.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { buildDraftBundle } from "../lib/sleeper/draft-service";
import { flexSlots, strictStartingSlots } from "../lib/sleeper/draft";
import { clearProjectionFeedCache } from "../lib/sleeper/client";
import { fixtureDrafts, fixtureLeague, fixtureRosters, fixtureUsers } from "./fixtures";

const PRE = fixtureDrafts.find((d) => d.status === "pre_draft")!;
const EMPTY_ROSTERS = fixtureRosters.map((r) => ({ ...r, players: [], starters: [], reserve: [], taxi: [] }));
const expectedRequiredSlots: Record<string, number> = {};
for (const s of strictStartingSlots(fixtureLeague.roster_positions ?? [])) expectedRequiredSlots[s] = (expectedRequiredSlots[s] ?? 0) + 1;
const expectedFlex = flexSlots(fixtureLeague.roster_positions ?? []).length;

function routeSleeper(type: "snake" | "auction") {
  const draft = { ...PRE, type, settings: { ...(PRE.settings ?? {}), ...(type === "auction" ? { budget: 200 } : {}) } };
  mock.method(globalThis, "fetch", async (u: string | URL | Request) => {
    const url = String(u); const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (/\/league\/[^/?]+$/.test(url)) return ok({ ...fixtureLeague, draft_id: draft.draft_id });
    if (/\/league\/[^/]+\/users/.test(url)) return ok(fixtureUsers);
    if (/\/league\/[^/]+\/rosters/.test(url)) return ok(EMPTY_ROSTERS);
    if (/\/league\/[^/]+\/drafts/.test(url)) return ok([draft]);
    if (/\/draft\/[^/]+\/picks/.test(url)) return ok([]);
    if (/\/draft\/[^/]+$/.test(url)) return ok(draft);
    return new Response("[]", { status: 404 }); // player database / projections: not needed pre-draft (the service degrades with a warning)
  });
}
beforeEach(() => clearProjectionFeedCache());
afterEach(() => mock.restoreAll());

for (const type of ["snake", "auction"] as const) {
  describe(`pre-draft guarantees (${type}, hermetic)`, () => {
    it("reports the pre-draft status without treating it as an error", async () => {
      routeSleeper(type); const { response } = await buildDraftBundle(fixtureLeague.league_id, { availableLimit: 25, position: null });
      assert.equal(response.draft?.status, "pre_draft"); assert.equal(response.draft?.completed_picks, 0); assert.equal(response.picks.length, 0); assert.equal(response.last_pick, null);
    });
    it("gives every team an empty roster (and a full budget in an auction)", async () => {
      routeSleeper(type); const { response } = await buildDraftBundle(fixtureLeague.league_id, { availableLimit: 25, position: null });
      assert.ok(response.teams.length > 0);
      for (const team of response.teams) {
        assert.equal(team.roster.players_acquired, 0); assert.equal(team.roster.slots_remaining, team.roster.slots_required); assert.deepEqual(team.positions, {});
        if (response.budget.supported) { assert.equal(type, "auction"); assert.equal(team.budget?.spent, 0); assert.equal(team.budget?.remaining, response.budget.starting_budget_per_team); } else { assert.equal(type, "snake"); assert.equal(team.budget, null); }
      }
    });
    it("reports the full starting lineup as still needed", async () => {
      routeSleeper(type); const { response } = await buildDraftBundle(fixtureLeague.league_id, { availableLimit: 25, position: null });
      for (const team of response.teams) {
        assert.deepEqual(Object.fromEntries(team.needs.required.map((n) => [n.position, n.minimum_needed])), expectedRequiredSlots);
        assert.equal(team.needs.flexible_slots_remaining, expectedFlex);
      }
    });
    it("leaves prices_available null when there is nothing to judge", async () => {
      routeSleeper(type); const { response } = await buildDraftBundle(fixtureLeague.league_id, { availableLimit: 25, position: null });
      assert.equal(response.budget.prices_available, null); assert.equal(response.budget.picks_missing_price, 0);
    });
  });
}
