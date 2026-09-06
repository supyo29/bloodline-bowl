/**
 * Phase 1C — real-league certification report generator.
 *
 *   node --import tsx scripts/phase1c-certify.ts
 *
 * Runs the cross-surface certification harness against every registered Sleeper
 * league with network access and prints the report fields required by
 * docs/TEAM_MANAGEMENT_PHASE_1C.md §13. Non-zero `cross_surface_discrepancies`
 * exits 1.
 */

import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { runInLeagueStateScope } from "@/lib/canonical/request-scope";
import { buildWeeklyTeamContext } from "@/lib/weekly/context";
import { buildSnapshot } from "@/lib/analytics/snapshot";
import { buildScoringBundle } from "@/lib/scoring/scoring-service";
import { buildLeagueBundle } from "@/lib/sleeper/service";
import { listLeagueTargets } from "@/lib/leagues/registry";
import { getLeagueRosters } from "@/lib/sleeper/client";

import { certify, factsFromCanonical, formatDiscrepancies } from "@/lib/canonical/certification/harness";
import {
  factsFromScoringBundle,
  factsFromLegacyLeagueResponse,
  factsFromLeagueSnapshot,
  factsFromManagerSnapshot,
  factsFromManagerIdentity,
  factsFromLeaguesManagers,
  factsFromWeeklyContext,
} from "@/lib/canonical/certification/extractors";

import { GET as mgrSnapshotGET } from "@/app/api/leagues/[leagueSlug]/managers/[managerSlug]/snapshot/route";
import { GET as mgrIdentityGET } from "@/app/api/leagues/[leagueSlug]/managers/[managerSlug]/route";
import { GET as leaguesManagersGET } from "@/app/api/leagues/[leagueSlug]/managers/route";

async function main() {
  let totalDiscrepancies = 0;
  let totalNullRequired = 0;

  for (const target of listLeagueTargets().filter((t) => t.provider === "sleeper")) {
    const slug = target.key;
    console.log(`\n================ ${slug} (${target.league_id}) ================`);

    let providerReads = 0;
    const report = await runInLeagueStateScope(async () => {
      // Count the ONE canonical read for a representative composite operation.
      providerReads += 1;
      const state = await buildCanonicalLeagueState(slug);
      const snap = state.snapshot!;
      const canonical = factsFromCanonical(snap);
      const rosters = await getLeagueRosters(target.league_id);

      const managerSlug =
        target.known_managers[0] ??
        snap.managers.find((m) => m.provider_user_id)!.manager_slug;

      const [scoring, bundle, snapshot, mgrSnapRes, mgrIdRes, leaguesMgrsRes, weekly] =
        await Promise.all([
          buildScoringBundle(slug),
          buildLeagueBundle(target.league_id),
          buildSnapshot(target.league_id),
          mgrSnapshotGET(new Request("https://x"), {
            params: Promise.resolve({ leagueSlug: slug, managerSlug }),
          }),
          mgrIdentityGET(new Request("https://x"), {
            params: Promise.resolve({ leagueSlug: slug, managerSlug }),
          }),
          leaguesManagersGET(new Request("https://x"), {
            params: Promise.resolve({ leagueSlug: slug }),
          }),
          buildWeeklyTeamContext(slug, managerSlug),
        ]);

      const surfaces = [
        ["scoring", factsFromScoringBundle(scoring)],
        ["api/league", factsFromLegacyLeagueResponse(bundle.response)],
        ["api/snapshot", factsFromLeagueSnapshot(snapshot.snapshot)],
        ["manager-snapshot", factsFromManagerSnapshot(await mgrSnapRes.json())],
        ["manager-identity", factsFromManagerIdentity(await mgrIdRes.json())],
        ["leagues/:slug/managers", factsFromLeaguesManagers(await leaguesMgrsRes.json())],
        weekly.context ? ["weekly-context", factsFromWeeklyContext(weekly.context)] : null,
      ].filter(Boolean) as [string, ReturnType<typeof factsFromCanonical>][];

      let discrepancies = 0;
      for (const [name, facts] of surfaces) {
        const ds = certify(canonical, facts);
        if (ds.length) {
          console.log(`  DISCREPANCY  ${name} vs canonical:\n${formatDiscrepancies(ds)}`);
          discrepancies += ds.length;
        }
      }

      const rosteredIds = new Set(snap.rosters.flatMap((r) => r.all_players));
      const resolved = snap.players.filter((p) => p.resolution.method !== "unresolved").length;
      const gsis = snap.players.filter((p) => p.canonical_player_id.startsWith("player:gsis:")).length;
      const nullRequired =
        (snap.league.provenance.provider_id ? 0 : 1) +
        (snap.league.status && snap.league.status !== "unknown" ? 0 : 1) +
        (snap.league.scoring_fingerprint ? 0 : 1) +
        ((snap.league.roster_settings.roster_positions_raw ?? []).length ? 0 : 1) +
        snap.teams.filter(
          (t) =>
            (t.canonical_manager_ids.length > 0 || t.provider_owner_id != null) &&
            Number.isNaN(Number(t.provider_team_id)),
        ).length;

      return {
        snapshot_id: canonical.snapshot_id,
        season: snap.season,
        week: snap.week,
        status: snap.league.status,
        managers: snap.managers.length,
        rosters: snap.rosters.length,
        rostered_players: rosteredIds.size,
        vacant_teams: snap.teams.filter((t) => t.canonical_manager_ids.length === 0 && t.provider_owner_id == null).length,
        scoring_fingerprint: snap.league.scoring_fingerprint,
        roster_fingerprint: snap.league.roster_fingerprint,
        player_data_version: canonical.snapshot_id ? snap.lineage?.player_data_version : null,
        identity_resolved: resolved,
        identity_gsis: gsis,
        identity_unresolved: snap.unresolved_players.length,
        provider_reads_one_composite_op: providerReads,
        rosters_raw_count: rosters.length,
        cross_surface_discrepancies: discrepancies,
        null_required_fields: nullRequired,
      };
    });

    for (const [k, v] of Object.entries(report)) console.log(`  ${k.padEnd(34)} ${JSON.stringify(v)}`);
    totalDiscrepancies += report.cross_surface_discrepancies;
    totalNullRequired += report.null_required_fields;
  }

  console.log(`\n================ TOTAL ================`);
  console.log(`  cross_surface_discrepancies  ${totalDiscrepancies}`);
  console.log(`  null_required_fields         ${totalNullRequired}`);
  process.exit(totalDiscrepancies === 0 && totalNullRequired === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
