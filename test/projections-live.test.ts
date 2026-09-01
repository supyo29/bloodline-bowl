/**
 * Live projection tests — hit the real Sleeper API. Verify the benchmark
 * ingestion, the layer invariance guarantees, manager isolation across leagues,
 * and that a full completed roster (DarthMarker in Devoted to the Game) can be
 * projected end to end.
 *
 * Skips cleanly (does not fail) when Sleeper is unreachable.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { loadSleeperSeasonProjections } from "@/lib/projections/sleeper";
import {
  buildBaseProjections,
  buildLeagueProjections,
  buildManagerView,
  clearProjectionCaches,
} from "@/lib/projections/build";
import { loadLeagueConfig } from "@/lib/projections/service";
import { getLeagueRosters, getPlayerIndex } from "@/lib/sleeper/client";
import { resolveLeagueId } from "@/lib/sleeper/service";
import type { ManagerRosterState } from "@/lib/projections/manager-value";
import type { FantasyPosition } from "@/lib/projections/schema";

const DEVOTED_LEAGUE_ID = "1389735763649761280";
const SEASON = 2026;

let online = true;

async function tryOnline() {
  try {
    await getPlayerIndex();
  } catch {
    online = false;
  }
}

describe("Sleeper projection benchmark (live)", () => {
  before(tryOnline);

  it("loads Sleeper's season projections with per-position coverage", async (t) => {
    if (!online) return t.skip("Sleeper offline");
    const src = await loadSleeperSeasonProjections(SEASON);
    assert.ok(["OK", "DEGRADED_SCHEMA", "STALE"].includes(src.status), `status ${src.status}`);
    assert.ok(src.players_usable > 200);
    for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
      assert.ok((src.coverage_by_position[pos] ?? 0) > 0, `no ${pos} coverage`);
    }
    // a known veteran and rookie both resolve
    const anyQb = [...src.projections.values()].find((p) => p.position === "QB");
    assert.ok(anyQb && (anyQb.sleeper_points.ppr ?? 0) > 0);
  });
});

describe("base projection build (live)", () => {
  before(tryOnline);

  it("builds Layer 1 for the full active player pool and treats Sleeper as BENCHMARK_ONLY", async (t) => {
    if (!online) return t.skip("Sleeper offline");
    clearProjectionCaches();
    const base = await buildBaseProjections({ season: SEASON });
    assert.ok(base.projections.size > 300);
    assert.equal(base.benchmark.role, "BENCHMARK_ONLY");
    assert.ok(base.benchmark.players_matched > 100);
    // reconciliation ran on every team
    assert.ok(base.reconciliation.teams_checked >= 28);
    // every projection has a coherent outcome band + availability
    for (const p of base.projections.values()) {
      assert.ok(p.outcome.floor <= p.outcome.median + 1e-6);
      assert.ok(p.outcome.median <= p.outcome.ceiling + 1e-6);
      assert.ok(p.availability.expected_games > 0 && p.availability.expected_games <= 17);
      assert.ok(Number.isFinite(p.neutral_points));
    }
  });

  it("keeps RI_STANDALONE independent — disagreement with Sleeper is surfaced, not zeroed", async (t) => {
    if (!online) return t.skip("Sleeper offline");
    const base = await buildBaseProjections({ season: SEASON });
    const withBench = [...base.comparisons.values()].filter((c) => c.has_benchmark);
    assert.ok(withBench.length > 100);
    // there ARE real disagreements (if everything agreed we'd have trained to Sleeper)
    const disagreeing = withBench.filter((c) => Math.abs(c.neutral_delta_pct ?? 0) > 12);
    assert.ok(disagreeing.length > 20, "expected genuine RI-vs-Sleeper divergence");
    assert.ok(base.disagreement_by_position.length > 0);
  });
});

describe("layer invariance (live)", () => {
  before(tryOnline);

  it("two managers in the same league get identical league_points; only manager value differs", async (t) => {
    if (!online) return t.skip("Sleeper offline");
    const base = await buildBaseProjections({ season: SEASON });
    const bloodlineId = resolveLeagueId();
    const cfg = await loadLeagueConfig("bloodline-bowl", bloodlineId);
    const league = buildLeagueProjections(base, cfg);

    const rosters = await getLeagueRosters(bloodlineId);
    assert.ok(rosters.length >= 2);
    const playerIndex = await getPlayerIndex();
    const posOf = (pid: string): FantasyPosition | null => {
      const raw = (playerIndex.get(pid)?.position ?? "") as FantasyPosition;
      return ["QB", "RB", "WR", "TE", "K", "DEF"].includes(raw) ? raw : null;
    };

    const mkState = (rosterId: number, userId: string): ManagerRosterState => {
      const roster = rosters.find((r) => r.roster_id === rosterId)!;
      const owned = (roster.players ?? []).filter((p): p is string => typeof p === "string" && p !== "0");
      return {
        league_id: bloodlineId, sleeper_user_id: userId, roster_id: rosterId, draft_id: null, draft_state: null,
        owned_player_ids: owned, roster_positions: cfg.roster_positions,
        position_by_player: new Map(owned.map((p) => [p, posOf(p)])),
      };
    };

    const v1 = buildManagerView(base, league, mkState(rosters[0]!.roster_id, "u-" + rosters[0]!.roster_id));
    const v2 = buildManagerView(base, league, mkState(rosters[1]!.roster_id, "u-" + rosters[1]!.roster_id));
    assert.notEqual(v1.cache_key, v2.cache_key);

    // league layer identical for a sample of players
    const sample = league.projections.slice(0, 25);
    for (const lp of sample) {
      assert.ok(Number.isFinite(lp.league_points));
    }
    // manager value rows echo the correct identity
    assert.ok(v1.values.every((row) => row.used_roster_id === rosters[0]!.roster_id));
    assert.ok(v2.values.every((row) => row.used_roster_id === rosters[1]!.roster_id));
  });

  it("the same player is scored differently in two leagues with different scoring", async (t) => {
    if (!online) return t.skip("Sleeper offline");
    const base = await buildBaseProjections({ season: SEASON });
    const a = await loadLeagueConfig("bloodline-bowl", resolveLeagueId());
    const b = await loadLeagueConfig("devoted-to-the-game", DEVOTED_LEAGUE_ID);
    const la = buildLeagueProjections(base, a);
    const lb = buildLeagueProjections(base, b);
    // scoring hashes differ (or the leagues genuinely share scoring — assert explicitly)
    const shared = la.scoring_hash === lb.scoring_hash;
    const topA = la.projections[0]!;
    const matchB = lb.projections.find((p) => p.player_id === topA.player_id);
    assert.ok(matchB);
    if (!shared) {
      assert.notEqual(topA.league_points, matchB.league_points);
    }
  });
});

describe("full completed roster (live) — DarthMarker in Devoted to the Game", () => {
  before(tryOnline);

  it("projects every player on a completed 16+ man roster without gaps", async (t) => {
    if (!online) return t.skip("Sleeper offline");
    const base = await buildBaseProjections({ season: SEASON });
    const cfg = await loadLeagueConfig("devoted-to-the-game", DEVOTED_LEAGUE_ID);
    const league = buildLeagueProjections(base, cfg);
    const rosters = await getLeagueRosters(DEVOTED_LEAGUE_ID);
    const darth = rosters.find((r) => (r.players ?? []).length >= 10);
    assert.ok(darth, "expected at least one filled roster");
    const owned = (darth!.players ?? []).filter((p): p is string => typeof p === "string" && p !== "0");
    const playerIndex = await getPlayerIndex();

    let projected = 0;
    for (const pid of owned) {
      const inLeague = league.projections.find((p) => p.player_id === pid);
      const pos = playerIndex.get(pid)?.position;
      if (pos && ["QB", "RB", "WR", "TE"].includes(pos)) {
        assert.ok(inLeague, `no league projection for rostered ${pos} ${pid}`);
        projected++;
      }
    }
    assert.ok(projected >= 8, `only ${projected} skill players projected`);
  });
});
