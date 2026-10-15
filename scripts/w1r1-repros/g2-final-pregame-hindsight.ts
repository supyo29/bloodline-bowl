/**
 * W1.R1 G2 reproduction: can a POST-kickoff request rewrite the frozen pregame forecast by combining an older pre-kickoff source observation with
 * newer live injury metadata? Runs unchanged on 65a04f4 (hole) and on the fixed tree. Prints one JSON line.
 * Run:  node --import tsx scripts/w1r1-repros/g2-final-pregame-hindsight.ts
 */
import { buildCanonicalForecastBatch } from "../../lib/weekly/forecast";
import { buildFinalPregameRecord, MemoryFinalPregameStore } from "../../lib/weekly/freshness/final-pregame";
import type { CanonicalPlayer } from "../../lib/canonical/schema";
import type { WeeklyProjectionBatch } from "../../lib/weekly/schema";
import { player, proj } from "../../test/fixtures/weekly";

const MIN = 60_000;
const KICK = Date.parse("2026-10-11T17:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const OBSERVED = KICK - 30 * MIN; // the ONE pre-kickoff source observation both requests ride on

const row = proj("WR1", "WR", 14, { injury_status: null, expected_availability: 1 });
const batch: WeeklyProjectionBatch = {
  league_slug: "rogers-park", season: 2026, week: 5, status: "READY", by_player: new Map([["WR1", row]]),
  resolved_players: new Map(), source: "sleeper_weekly", model_version: "v", missing: [], teams_with_games: ["KC"], warnings: [],
  source_observation: { provider: "sleeper", observed_at: iso(OBSERVED), observation_id: "srcobs:abc", content_hash: "h", fetch_path: "LIVE_FETCH" },
};
const compose = (nowMs: number, liveInjury: string | null) => {
  const live: CanonicalPlayer = { ...player("WR1", "WR", { team: "KC", injury: liveInjury }), identifiers: { sleeper_id: "WR1" } };
  const f = buildCanonicalForecastBatch({
    batch, requested_player_ids: ["WR1"], players: new Map([["WR1", live]]),
    freshness: { now_ms: nowMs, league_slug: "rogers-park", provider: "yahoo", kickoffFor: () => ({ kickoff_at: iso(KICK), game_id: "g1" }) },
  }).by_player.get("WR1")!;
  const rec = buildFinalPregameRecord({ forecast: f, league_slug: "rogers-park", provider: "yahoo", scoring_fingerprint: "fp", source_observation_id: "srcobs:abc", recorded_at: iso(nowMs) });
  return { f, rec };
};

(async () => {
  const store = new MemoryFinalPregameStore();
  const pre = compose(KICK - 20 * MIN, null); // pre-kickoff request: healthy, 14 points
  const w1 = await store.upsertCandidate(pre.rec!);
  const post = compose(KICK + 10 * MIN, "Out"); // post-kickoff request: live metadata now says Out, SAME old observation
  const w2 = await store.upsertCandidate(post.rec!);
  const frozen = await store.get("rogers-park", 2026, 5, "WR1");
  console.log(JSON.stringify({
    g: "G2",
    pre_kickoff_write: w1,
    pre_kickoff_expected_points: pre.f.projection.expected_points,
    post_kickoff_request_would_compute: post.f.projection.expected_points,
    post_kickoff_write: w2,
    frozen_expected_points_after: frozen?.expected_points ?? null,
    frozen_record_rewritten_by_post_kickoff_request: frozen?.expected_points !== pre.f.projection.expected_points,
  }));
})();
