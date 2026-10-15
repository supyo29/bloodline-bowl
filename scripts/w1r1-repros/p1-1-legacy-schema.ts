/**
 * W1.R1 P1-1 reproduction: W1.P4 snapshot store against the PRE-W1.P4 pointer schema, with errors in the exact shape the production
 * REST wrapper emits. Runs unchanged on 65a04f4 (defect) and on the fixed tree. Prints one JSON line.
 * Run from the repo root:  node --import tsx scripts/w1r1-repros/p1-1-legacy-schema.ts
 */
import { NoCrosswalk, PlayerCrosswalk } from "@/lib/canonical/players";
import { SupabaseProjectionSnapshotStore } from "@/lib/persistence/supabase/projection-snapshot";
import { CanonicalProjectionSnapshotProvider } from "@/lib/weekly/projections/canonical-provider";
import type { ProjectionProvider, ProjectionRequest } from "@/lib/weekly/projections/types";
import type { WeeklyProjectionBatch } from "@/lib/weekly/schema";
import { FakeRest } from "../../test/fixtures/fake-rest";
import { player, proj } from "../../test/fixtures/weekly";

const MIN = 60_000;
const KICK = Date.parse("2026-10-11T17:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const clock = { now: KICK - 100 * 60 * MIN };

const req: ProjectionRequest = {
  league: { league_slug: "repro-league", season: 2026, raw_scoring: { rec: 1, rec_yd: 0.1, rec_td: 6 }, scoring_rules: [] },
  week: 5, crosswalk: new PlayerCrosswalk(NoCrosswalk), canonical_player_ids: ["p1"], want_rest_of_season: true,
};
let liveCalls = 0;
const live: ProjectionProvider = {
  name: "fake_live", model_version: "v1",
  async getWeeklyProjections(): Promise<WeeklyProjectionBatch> {
    liveCalls += 1;
    return {
      league_slug: "repro-league", season: 2026, week: 5, status: "READY",
      by_player: new Map([["p1", proj("p1", "WR", 10, { rest_of_season_points: 120 })]]),
      resolved_players: new Map([["p1", player("p1", "WR")]]),
      source: "fake_live", model_version: "v1", missing: [], teams_with_games: ["KC"], warnings: [],
      source_observation: { provider: "sleeper", observed_at: iso(clock.now), observation_id: null, content_hash: null, fetch_path: "LIVE_FETCH" },
    };
  },
};
const kickoff = { name: "fx", getWeekGames: async () => [{ game_id: "g", home_team: "KC", away_team: "LV", kickoff_at: iso(KICK), status: "pre_game" }] };

(async () => {
  const fake = new FakeRest();
  fake.missingColumns = new Set(["source_observed_at", "source_observation_id"]); // migration NOT applied
  const mk = () => new CanonicalProjectionSnapshotProvider(live, new SupabaseProjectionSnapshotStore(fake.asRest()), { now: () => clock.now, kickoffSource: kickoff });
  const first = await mk().getWeeklyProjections(req);
  clock.now += 20 * MIN;
  const second = await mk().getWeeklyProjections(req); // a different instance: no process memo
  console.log(JSON.stringify({
    p1: "P1-1",
    first_write_durable: first.canonical_snapshot?.durable ?? null,
    first_write_warning: first.warnings.find((w) => w.code.startsWith("canonical_projection_snapshot"))?.message ?? null,
    pointer_rows_written: fake.t("bridge_projection_latest").length,
    second_read_path: second.canonical_snapshot?.read_path ?? null,
    live_calls_for_two_requests: liveCalls,
    durable_reuse_preserved: second.canonical_snapshot?.read_path === "SUPABASE_HIT" && liveCalls === 1,
  }));
})();
