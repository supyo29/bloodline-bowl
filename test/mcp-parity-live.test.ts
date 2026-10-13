/**
 * MCP connector — live parity with the bridge routes (network; skips offline).
 *
 * For Mark's league (devoted-to-the-game / darthmarker) and John's
 * (bloodline-bowl / supyo29), every analytical number a tool returns must equal
 * the number the public route returns for the same snapshot. If the snapshot
 * moves between the two reads (live data refreshed mid-test) the pair is
 * skipped rather than compared across snapshots.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { getNflState } from "../lib/sleeper/client";
import { callRoute } from "../lib/mcp/invoke";
import { runTool, TOOLS } from "../lib/mcp/tools";

let online = false;
let week = 0;

before(async () => {
  try {
    const s = await Promise.race([getNflState(), new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
    week = Number(s?.week);
    online = Number.isInteger(week) && week >= 1;
  } catch {
    online = false;
  }
});

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
type Env = { status: string; data: Record<string, unknown>; provenance: { league_snapshot_id: string | null } };
const env = async (name: string, args: Record<string, unknown>) => (await runTool(tool(name), args)).structuredContent as unknown as Env;

const CASES = [
  { league: "devoted-to-the-game", manager: "darthmarker", leagueName: "Devoted to the Game", managerName: "DarthMarker" },
  { league: "bloodline-bowl", manager: "supyo29", leagueName: "Bloodline Bowl", managerName: "Supyo29" },
];

for (const c of CASES) {
  describe(`MCP parity (live) — ${c.league}/${c.manager}`, () => {
    it("start/sit: every slot and total equals /api/lineup", async (t) => {
      if (!online) return t.skip("offline");
      const e = await env("bloodline_start_sit", { league: c.leagueName, manager: c.managerName });
      const r = await callRoute({ route: "lineup", params: { league: c.league, manager: c.manager, week: String(week) } });
      assert.ok(r.ok);
      const body = r.body as { status: string; context: { lineage: { snapshot: { league_snapshot_id: string } } }; data: { lineup: { optimal_total: number; current_total: number; slots: Array<Record<string, unknown>> }; start_sit: Array<Record<string, unknown>> } };
      if (body.context.lineage.snapshot.league_snapshot_id !== e.provenance.league_snapshot_id) return t.skip("snapshot moved between reads");
      assert.equal(e.status, body.status);
      const lineup = e.data.lineup as { optimal_total: number; current_total: number };
      assert.equal(lineup.optimal_total, body.data.lineup.optimal_total);
      assert.equal(lineup.current_total, body.data.lineup.current_total);
      const slots = e.data.slots as Array<{ slot: string; recommended: { id: string; projected: number }; current: { id: string; projected: number } }>;
      assert.equal(slots.length, body.data.lineup.slots.length);
      slots.forEach((s, i) => {
        const src = body.data.lineup.slots[i]!;
        assert.equal(s.slot, src.slot);
        assert.equal(s.recommended.id, src.recommended_player_id);
        assert.equal(s.recommended.projected, src.recommended_projected);
        assert.equal(s.current.id, src.current_player_id);
        assert.equal(s.current.projected, src.current_projected);
      });
      assert.equal((e.data.start_sit as unknown[]).length, body.data.start_sit.length);
    });

    it("waivers: recommendation order and values equal /api/waivers", async (t) => {
      if (!online) return t.skip("offline");
      const e = await env("bloodline_waiver_analysis", { league: c.league, manager: c.manager });
      const r = await callRoute({ route: "waivers", params: { league: c.league, manager: c.manager, week: String(week) } });
      assert.ok(r.ok);
      const body = r.body as { status: string; context: { lineage: { snapshot: { league_snapshot_id: string } } }; data: { availability_status: string; recommendations: Array<Record<string, unknown>> } };
      if (body.context.lineage.snapshot.league_snapshot_id !== e.provenance.league_snapshot_id) return t.skip("snapshot moved between reads");
      assert.equal(e.status, body.status);
      assert.equal(e.data.availability_status, body.data.availability_status);
      const recs = e.data.recommendations as Array<{ add: { id: string }; net_roster_gain: number; priority: string; confidence: string }>;
      assert.deepEqual(
        recs.map((x) => [x.add.id, x.net_roster_gain, x.priority, x.confidence]),
        body.data.recommendations.map((x) => [x.add_player_id, x.net_roster_gain, x.priority, x.confidence]),
      );
    });

    it("weekly analysis: headline numbers equal /api/intelligence", async (t) => {
      if (!online) return t.skip("offline");
      const e = await env("bloodline_weekly_analysis", { league: c.league, manager: c.manager });
      const r = await callRoute({ route: "intelligence", params: { league: c.league, manager: c.manager, week: String(week) } });
      assert.ok(r.ok);
      const i = (r.body as { status: string; intelligence: Record<string, Record<string, unknown>> }).intelligence;
      if ((i.lineage!.snapshot as { league_snapshot_id: string }).league_snapshot_id !== e.provenance.league_snapshot_id) return t.skip("snapshot moved between reads");
      assert.equal(e.status, (r.body as { status: string }).status);
      assert.deepEqual(e.data.summary, i.summary);
      const m = e.data.matchup as Record<string, unknown>;
      for (const k of ["projected_margin", "win_probability", "win_probability_confidence", "team_optimal_total", "opponent_optimal_total"]) assert.equal(m[k], i.matchup![k], k);
      assert.equal(JSON.stringify(e.data).includes('"SHADOW_ONLY"'), false, "no shadow label inside production data");
    });

    it("scoring: every rule equals /api/leagues/{league}/scoring", async (t) => {
      if (!online) return t.skip("offline");
      const e = await env("bloodline_get_scoring", { league: c.league });
      const r = await callRoute({ route: "scoring", params: { leagueSlug: c.league } });
      assert.ok(r.ok);
      const rules = (r.body as { scoring: { normalized: Array<{ key: string; points: number }> } }).scoring.normalized;
      assert.deepEqual((e.data.rules as Array<{ key: string; points: number }>).map((x) => [x.key, x.points]), rules.map((x) => [x.key, x.points]));
    });

    it("team: identity resolves to the right manager and never another one", async (t) => {
      if (!online) return t.skip("offline");
      const e = (await runTool(tool("bloodline_get_team"), { league: c.leagueName, manager: c.managerName })).structuredContent as unknown as { identity: { manager_slug: string }; data: { manager: { manager_slug: string } } };
      assert.equal(e.identity.manager_slug, c.manager);
      assert.equal(e.data.manager.manager_slug, c.manager);
    });
  });
}

describe("MCP cross-league identity (live)", () => {
  it("a manager from another league is rejected, not substituted", async (t) => {
    if (!online) return t.skip("offline");
    const e = (await runTool(tool("bloodline_get_team"), { league: "devoted-to-the-game", manager: "supyo29" })).structuredContent as unknown as { status: string; data: unknown };
    assert.equal(e.status, "MANAGER_NOT_FOUND");
    assert.equal(e.data, null);
  });

  it("a non-current week is passed to the bridge and rejected, never swapped for the current week", async (t) => {
    if (!online || week < 2) return t.skip("offline");
    const e = (await runTool(tool("bloodline_start_sit"), { league: "devoted-to-the-game", manager: "darthmarker", week: week - 1 })).structuredContent as unknown as { status: string; next_steps: string[] };
    assert.equal(e.status, "NON_CURRENT_WEEK_UNSUPPORTED");
    assert.ok(e.next_steps.some((s) => s.includes("bloodline_week_history")));
  });
});
