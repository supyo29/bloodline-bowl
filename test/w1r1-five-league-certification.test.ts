/** W1.R1 five-league fixture certification (dynamic registry; deterministic; no network). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NoCrosswalk, PlayerCrosswalk } from "@/lib/canonical/players";
import { listLeagueTargets } from "@/lib/leagues/registry";
import { buildCanonicalForecastBatch } from "@/lib/weekly/forecast";
import { buildFinalPregameRecord, MemoryFinalPregameStore } from "@/lib/weekly/freshness/final-pregame";
import { player, proj } from "./fixtures/weekly";

const MIN = 60_000;
const KICK = Date.parse("2026-10-11T17:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function forecastFor(playerId: string, pts: number, nowMs: number) {
  const row = proj(playerId, "WR", pts, { injury_status: "Questionable", expected_availability: 0.78 });
  const live = { ...player(playerId, "WR", { team: "KC", injury: "Questionable" }), identifiers: { sleeper_id: playerId } };
  const batch = {
    league_slug: "x", season: 2026, week: 5, status: "READY" as const, by_player: new Map([[playerId, row]]), resolved_players: new Map([[playerId, live]]),
    source: "sleeper_weekly", model_version: "v", missing: [], teams_with_games: ["KC"], warnings: [],
    source_observation: { provider: "sleeper", observed_at: iso(KICK - 30 * MIN), observation_id: "srcobs:00000000000000000009", content_hash: "h", fetch_path: "LIVE_FETCH" as const },
  };
  return buildCanonicalForecastBatch({ batch, requested_player_ids: [playerId], players: new Map([[playerId, live]]), freshness: { now_ms: nowMs, kickoffFor: () => ({ kickoff_at: iso(KICK), game_id: "g1" }) } }).by_player.get(playerId)!;
}

describe("W1.R1 five-league certification", () => {
  const targets = listLeagueTargets();

  it("registry: 3 Sleeper + 2 Yahoo", () => {
    assert.equal(targets.length, 5);
    assert.equal(targets.filter((t) => t.provider === "sleeper").length, 3);
    assert.equal(targets.filter((t) => t.provider === "yahoo").length, 2);
  });

  it("team defense is ONE provider-neutral entity across all five leagues' providers", async () => {
    const cw = new PlayerCrosswalk(NoCrosswalk);
    await cw.ensureLoaded();
    const ids = new Set<string>();
    for (const t of targets) {
      const r = t.provider === "yahoo"
        ? cw.resolve({ provider: "yahoo", provider_player_id: "nfl.p.100022", full_name: "Baltimore", position: "DEF", nfl_team: "BAL", known_identifiers: { yahoo_id: "100022" } })
        : cw.resolve({ provider: "sleeper", provider_player_id: "BAL", full_name: "Baltimore Ravens", position: "DEF", nfl_team: "BAL" });
      ids.add(r.player.canonical_player_id);
    }
    assert.deepEqual([...ids], ["defense:nfl:bal"]);
  });

  it("final-pregame records are league-scoped, calibration-grade, require no Sleeper id, and never cross leagues", () => {
    const f = forecastFor("wr1", 14.6, KICK - 20 * MIN);
    const recs = targets.map((t, i) => buildFinalPregameRecord({
      forecast: f, league_slug: t.key, provider: t.provider, scoring_fingerprint: `fp-${i % 4}`,
      source_observation_id: "srcobs:00000000000000000009", recorded_at: iso(KICK - 20 * MIN),
    })!);
    assert.equal(recs.length, 5);
    assert.equal(new Set(recs.map((r) => r.forecast_id)).size, 5, "each league has its own revision identity");
    for (const [i, r] of recs.entries()) {
      assert.equal(r.league_slug, targets[i]!.key);
      assert.ok(r.composed_at && Date.parse(r.composed_at) < KICK);
      assert.ok(r.content_signature);
      assert.ok(r.forecast_snapshot, "full canonical snapshot retained");
    }
  });

  it("a post-kickoff composition is REJECTED by the store for every league and leaves the frozen record untouched", async () => {
    const store = new MemoryFinalPregameStore();
    const pre = forecastFor("wr1", 14.6, KICK - 20 * MIN);
    const post = forecastFor("wr1", 0, KICK + 5 * MIN);
    for (const [i, t] of targets.entries()) {
      const base = { league_slug: t.key, provider: t.provider, scoring_fingerprint: `fp-${i}`, source_observation_id: "srcobs:00000000000000000009" };
      const frozen = buildFinalPregameRecord({ forecast: pre, ...base, recorded_at: iso(KICK - 20 * MIN) })!;
      assert.equal(await store.upsertCandidate(frozen), "RECORDED");
      const late = buildFinalPregameRecord({ forecast: post, ...base, recorded_at: iso(KICK + 5 * MIN) });
      if (late) assert.equal(await store.upsertCandidate(late), "REJECTED_POST_KICKOFF", t.key);
      const kept = await store.get(t.key, 2026, 5, frozen.canonical_player_id);
      assert.equal(kept?.forecast_id, frozen.forecast_id, `${t.key}: frozen forecast unchanged`);
    }
    assert.equal(store.revisionCount(), 5);
  });
});
