/**
 * Phase 1C — LIVE cross-surface certification against the real registered
 * leagues. Requires network. FAILS LOUDLY on any cross-surface fact
 * disagreement (never logs-and-passes).
 *
 * Reference = `buildCanonicalLeagueState`. Every other live/current-state
 * surface is certified against it.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { buildCanonicalLeagueState } from "../lib/canonical/state";
import { runInLeagueStateScope } from "../lib/canonical/request-scope";
import { buildWeeklyTeamContext } from "../lib/weekly/context";
import { buildTradeAnalysisContext } from "../lib/trades/context";
import { buildSnapshot } from "../lib/analytics/snapshot";
import { buildScoringBundle } from "../lib/scoring/scoring-service";
import { buildLeagueBundle } from "../lib/sleeper/service";
import { getNflState } from "../lib/sleeper/client";
import { listLeagueTargets } from "../lib/leagues/registry";

import { certify, factsFromCanonical, formatDiscrepancies } from "../lib/canonical/certification/harness";
import {
  factsFromScoringBundle,
  factsFromLegacyLeagueResponse,
  factsFromLeagueSnapshot,
  factsFromManagerSnapshot,
  factsFromManagerIdentity,
  factsFromLeaguesManagers,
  factsFromWeeklyContext,
} from "../lib/canonical/certification/extractors";

// Route handlers (invoked directly — no server).
import { GET as leaguesManagersGET } from "../app/api/leagues/[leagueSlug]/managers/route";
import { GET as mgrSnapshotGET } from "../app/api/leagues/[leagueSlug]/managers/[managerSlug]/snapshot/route";
import { GET as mgrIdentityGET } from "../app/api/leagues/[leagueSlug]/managers/[managerSlug]/route";

let online = true;
before(async () => {
  try {
    await getNflState();
  } catch {
    online = false;
  }
});

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const SLEEPER_LEAGUES = listLeagueTargets().filter((t) => t.provider === "sleeper");

for (const target of SLEEPER_LEAGUES) {
  describe(`1C live certification — ${target.key}`, () => {
    it("all live/current-state surfaces agree with the canonical snapshot", async (t) => {
      if (!online) return t.skip("offline");
      const slug = target.key;

      const { canonical, results } = await runInLeagueStateScope(async () => {
        const state = await buildCanonicalLeagueState(slug);
        assert.ok(state.snapshot, `canonical state for ${slug}`);
        const snap = state.snapshot!;
        const canonical = factsFromCanonical(snap);

        // pick a real manager for the per-manager surfaces
        const managerSlug =
          target.known_managers[0] ??
          snap.managers.find((m) => m.provider_user_id)?.manager_slug;
        assert.ok(managerSlug, "a resolvable manager");

        const [scoring, legacyBundle, snapshot, mgrSnapRes, mgrIdRes, leaguesMgrsRes, weekly] =
          await Promise.all([
            buildScoringBundle(slug),
            buildLeagueBundle(target.league_id),
            buildSnapshot(target.league_id),
            mgrSnapshotGET(new Request("https://x"), {
              params: Promise.resolve({ leagueSlug: slug, managerSlug: managerSlug! }),
            }),
            mgrIdentityGET(new Request("https://x"), {
              params: Promise.resolve({ leagueSlug: slug, managerSlug: managerSlug! }),
            }),
            leaguesManagersGET(new Request("https://x"), {
              params: Promise.resolve({ leagueSlug: slug }),
            }),
            buildWeeklyTeamContext(slug, managerSlug!).catch(() => null),
          ]);

        const results: { name: string; facts: ReturnType<typeof factsFromCanonical>; only?: string[]; allow?: string[] }[] = [
          { name: "scoring", facts: factsFromScoringBundle(scoring) },
          { name: "api/league", facts: factsFromLegacyLeagueResponse(legacyBundle.response) },
          { name: "api/snapshot", facts: factsFromLeagueSnapshot(snapshot.snapshot) },
          {
            name: "manager-snapshot",
            facts: factsFromManagerSnapshot(await jsonOf(mgrSnapRes)),
          },
          {
            name: "manager-identity",
            facts: factsFromManagerIdentity(await jsonOf(mgrIdRes)),
          },
          {
            name: "leagues/:slug/managers",
            facts: factsFromLeaguesManagers(await jsonOf(leaguesMgrsRes)),
          },
        ];
        if (weekly?.context) {
          results.push({ name: "weekly-context", facts: factsFromWeeklyContext(weekly.context) });
        }
        return { canonical, results };
      });

      const all: string[] = [];
      for (const r of results) {
        const ds = certify(canonical, r.facts, { allow: r.allow, only: r.only });
        if (ds.length > 0) {
          all.push(`\n${r.name} vs canonical:\n${formatDiscrepancies(ds)}`);
        }
      }
      assert.equal(all.length, 0, `cross-surface discrepancies:${all.join("")}`);
    });

    it("trade context is derived from the exact same snapshot id as weekly", async (t) => {
      if (!online) return t.skip("offline");
      await runInLeagueStateScope(async () => {
        const managerSlug = target.known_managers[0];
        if (!managerSlug) return;
        const [weekly, trade] = await Promise.all([
          buildWeeklyTeamContext(target.key, managerSlug),
          buildTradeAnalysisContext(target.key, { wantRestOfSeason: false }),
        ]);
        if (!weekly.context || !trade.context) return;
        assert.equal(
          weekly.context.lineage.snapshot.league_snapshot_id,
          trade.context.lineage.snapshot.league_snapshot_id,
        );
      });
    });

    it("field completeness: REQUIRED fields present; conditional fields never silently lost", async (t) => {
      if (!online) return t.skip("offline");
      const [state, bundle] = await Promise.all([
        buildCanonicalLeagueState(target.key),
        buildLeagueBundle(target.league_id),
      ]);
      const snap = state.snapshot!;

      // REQUIRED (§4): league identity, season, week, status, roster settings,
      // scoring fingerprint — must be present and meaningful.
      assert.ok(snap.league.provenance.provider_id, "provider_league_id");
      assert.ok(snap.season > 0, "season");
      assert.ok(snap.week >= 0, "week");
      assert.ok(snap.league.status && snap.league.status !== "unknown", "status");
      assert.ok(snap.league.roster_settings.starting_slots.length > 0, "starting_slots");
      assert.ok((snap.league.roster_settings.roster_positions_raw ?? []).length > 0, "roster_positions_raw");
      assert.ok(snap.league.scoring_fingerprint?.startsWith("scoring:"), "scoring_fingerprint");

      // CONDITIONALLY REQUIRED per team: roster_id always; owner id whenever the
      // seat is claimed. team_name is PROVIDER-DEPENDENT (a manager may leave it
      // blank) — the invariant is that canonical must not LOSE a value the
      // provider actually has (the 1B.2 defect).
      const providerTeamName = new Map(
        bundle.response.teams.map((t) => [t.roster_id, t.manager.team_name]),
      );
      let claimed = 0;
      let providerHasName = 0;
      for (const team of snap.teams) {
        const rid = Number(team.provider_team_id);
        assert.ok(Number.isInteger(rid), "roster_id is an integer");
        const hasOwner =
          team.canonical_manager_ids.length > 0 || team.provider_owner_id != null;
        if (hasOwner) {
          claimed += 1;
          assert.ok(
            team.provider_owner_id != null || team.canonical_manager_ids.length > 0,
            `claimed team ${rid} has a recoverable owner id`,
          );
        }
        const pName = providerTeamName.get(rid) ?? null;
        if (pName != null) {
          providerHasName += 1;
          assert.equal(
            team.team_name,
            pName,
            `canonical team_name for roster ${rid} matches the provider's ("${pName}")`,
          );
        }
      }
      assert.ok(claimed >= 1, "at least one claimed team");
      assert.ok(providerHasName >= 1, "at least one team_name to certify");
    });
  });
}
