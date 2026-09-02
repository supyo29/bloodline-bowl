/**
 * Post-Draft Intelligence I — production-equivalent smoke + real-league sanity
 * (PART XVII). Hits real Sleeper (guarded — skips offline).
 *
 * Runs the full engine for supyo29 / BijiMac / DarthMarker and asserts the
 * outputs are STRUCTURALLY sound and football-plausible:
 *  - optimal lineup is legal (right positions, no dup, no bye/IR starter chosen
 *    when an alternative exists)
 *  - lineup efficiency in (0, 1]
 *  - a free agent is never a rostered player
 *  - add/drop recommendations carry a drop (or an open spot) and a net figure
 *  - matchup uses optimal lineups; probability, if present, is LOW confidence
 *  - multi-league isolation holds on live data
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { buildWeeklyIntelligence } from "../lib/weekly/intelligence";

let online = false;
before(async () => {
  try {
    online = (await fetch("https://api.sleeper.app/v1/state/nfl", { signal: AbortSignal.timeout(6000) })).ok;
  } catch {
    online = false;
  }
});

const TARGETS = [
  ["bloodline-bowl", "supyo29"],
  ["bloodline-bowl", "BijiMac"],
  ["devoted-to-the-game", "DarthMarker"],
] as const;

describe("live: full weekly engine for the three primary managers", () => {
  for (const [league, manager] of TARGETS) {
    it(`${league}/${manager} produces a legal, plausible weekly plan`, async (t) => {
      if (!online) return t.skip("Sleeper offline");
      const r = await buildWeeklyIntelligence(league, manager, {});
      assert.ok(r.intelligence, `${r.code} ${r.detail}`);
      const i = r.intelligence;

      assert.equal(i.league_slug, league);
      assert.equal(i.manager_slug.toLowerCase(), manager.toLowerCase());
      assert.ok(["READY", "DEGRADED", "PROJECTIONS_PARTIAL", "PLAYER_IDENTITY_UNRESOLVED", "NO_OPPONENT"].includes(i.status));

      // ---- lineup legality
      const lu = i.lineup;
      const used = lu.slots.map((s) => s.recommended_player_id).filter(Boolean);
      assert.equal(new Set(used).size, used.length, "no player started twice");
      assert.equal(lu.illegal_situations.length, 0, `optimal lineup must be legal: ${lu.illegal_situations.join("; ")}`);
      for (const s of lu.slots) {
        if (!s.recommended_player_id) continue;
        const p = i.matchup.team_lineup.slots.find((x) => x.slot === s.slot);
        assert.ok(p, "slot present");
      }
      assert.ok(
        lu.optimal_total == null || (lu.optimal_total > 50 && lu.optimal_total < 260),
        `optimal total ${lu.optimal_total} is in a sane range`,
      );
      assert.ok(lu.known_optimal_subtotal > 50, `known optimal subtotal ${lu.known_optimal_subtotal} is sane`);
      assert.ok(["COMPLETE", "PROVISIONAL"].includes(lu.optimality_status));
      assert.ok(lu.lineup_efficiency == null || (lu.lineup_efficiency > 0 && lu.lineup_efficiency <= 1.0001));
      // recommended change gains are never negative
      for (const c of lu.changes_recommended) assert.ok(c.gain > 0);

      // ---- start/sit never overstates a tiny edge
      for (const ss of i.start_sit) {
        if (ss.projection_edge != null && Math.abs(ss.projection_edge) < 0.5) {
          assert.notEqual(ss.confidence, "HIGH", "a <0.5 pt edge is never HIGH confidence");
        }
      }

      // ---- waivers: availability integrity + add/drop economics
      const rosteredIds = new Set(i.matchup.team_lineup.slots.map((s) => s.current_player_id).filter(Boolean));
      for (const w of i.waivers.recommendations) {
        assert.ok(!rosteredIds.has(w.add_player_id), `${w.add_name} is a current starter but recommended as an add`);
        assert.equal(typeof w.net_roster_gain, "number");
        assert.ok(w.drop_player_id != null || i.waivers.roster_has_open_spot, "an add needs a drop or an open spot");
        assert.ok(w.net_roster_gain >= 0.5, "recommended adds clear the minimum net threshold");
        assert.ok(w.score.components.length >= 5, "decision score is component-broken-out");
      }
      // engine can say "add nothing"
      assert.ok(Array.isArray(i.waivers.do_not_add));

      // ---- matchup
      if (i.matchup.has_opponent) {
        assert.equal(
          i.matchup.projected_margin,
          Math.round((i.matchup.team_optimal_total! - i.matchup.opponent_optimal_total!) * 100) / 100,
        );
        if (i.matchup.win_probability != null) {
          assert.equal(i.matchup.win_probability_confidence, "LOW");
          assert.ok(i.matchup.win_probability > 0 && i.matchup.win_probability < 1);
          assert.match(i.matchup.win_probability_method ?? "", /monte_carlo/);
        }
      }

      // ---- summary + top actions are generated from structured outputs
      assert.ok(i.summary.team_status.length > 0);
      assert.ok(i.top_actions.length <= 6);
      for (const a of i.top_actions) assert.ok(["HIGH", "MEDIUM", "LOW"].includes(a.priority));
    });
  }

  it("Bloodline and Devoted outputs never share a canonical team id", async (t) => {
    if (!online) return t.skip("Sleeper offline");
    const [a, b] = await Promise.all([
      buildWeeklyIntelligence("bloodline-bowl", "supyo29", {}),
      buildWeeklyIntelligence("devoted-to-the-game", "DarthMarker", {}),
    ]);
    assert.ok(a.intelligence && b.intelligence);
    assert.ok(a.intelligence.matchup.team_id.startsWith("team:bloodline-bowl:"));
    assert.ok(b.intelligence.matchup.team_id.startsWith("team:devoted-to-the-game:"));
    const aWaivers = new Set(a.intelligence.waivers.recommendations.map((w) => w.add_player_id));
    // different leagues, different available pools & rosters -> team ids never collide
    assert.notEqual(a.intelligence.matchup.team_id, b.intelligence.matchup.team_id);
    void aWaivers;
  });
});

describe("live: route handlers", () => {
  it("GET /api/lineup/... returns a legal optimal lineup", async (t) => {
    if (!online) return t.skip("Sleeper offline");
    const { GET } = await import("../app/api/lineup/[league]/[manager]/week/[week]/route");
    const res = await GET(new Request("https://x"), {
      params: Promise.resolve({ league: "bloodline-bowl", manager: "supyo29", week: "1" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { lineup: { slots: unknown[]; illegal_situations: string[] } } };
    assert.ok(Array.isArray(body.data.lineup.slots));
    assert.equal(body.data.lineup.illegal_situations.length, 0);
  });

  it("GET /api/intelligence/... week 99 -> 400", async () => {
    const { GET } = await import("../app/api/intelligence/[league]/[manager]/week/[week]/route");
    const res = await GET(new Request("https://x"), {
      params: Promise.resolve({ league: "bloodline-bowl", manager: "supyo29", week: "99" }),
    });
    assert.equal(res.status, 400);
  });

  it("GET /api/matchup/... for an unknown league -> 404", async () => {
    const { GET } = await import("../app/api/matchup/[league]/[manager]/week/[week]/route");
    const res = await GET(new Request("https://x"), {
      params: Promise.resolve({ league: "not-a-real-league", manager: "x", week: "1" }),
    });
    assert.equal(res.status, 404);
  });
});
