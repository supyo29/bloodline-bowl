/** Emits psql \set lines holding REAL production-built values (a real frozen revision record, real srcobs id) for the Postgres compatibility check. */
import { buildCanonicalForecastBatch } from "../../lib/weekly/forecast";
import { buildFinalPregameRecord } from "../../lib/weekly/freshness/final-pregame";
import { observationContentHash } from "../../lib/weekly/freshness/observation";
import { contentHash } from "../../lib/bridge/hash";
import { player, proj } from "../../test/fixtures/weekly";

const MIN = 60_000;
const KICK = Date.parse("2026-10-11T17:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

const players = [{ provider: "sleeper", provider_player_id: "wr1", position: "WR", nfl_team: "KC", opponent: "LV", injury_status: "Questionable", gp: 1, stats: { rec: 6, rec_yd: 80 } }];
const observedAt = iso(KICK - 30 * MIN);
const srcobs = `srcobs:${contentHash({ p: "sleeper", s: 2026, w: 5, t: observedAt, h: observationContentHash(players) }).slice(0, 20)}`;
const row = proj("wr1", "WR", 14.6, { injury_status: "Questionable", expected_availability: 0.78 });
const live = { ...player("wr1", "WR", { team: "KC", injury: "Questionable" }), identifiers: { sleeper_id: "wr1" } };
const batch = {
  league_slug: "rogers-park", season: 2026, week: 5, status: "READY" as const, by_player: new Map([["wr1", row]]), resolved_players: new Map([["wr1", live]]),
  source: "sleeper_weekly", model_version: "v", missing: [], teams_with_games: ["KC"], warnings: [],
  source_observation: { provider: "sleeper", observed_at: observedAt, observation_id: srcobs, content_hash: "h", fetch_path: "LIVE_FETCH" as const },
};
const f = buildCanonicalForecastBatch({ batch, requested_player_ids: ["wr1"], players: new Map([["wr1", live]]), freshness: { now_ms: KICK - 20 * MIN, kickoffFor: () => ({ kickoff_at: iso(KICK), game_id: "g1" }) } }).by_player.get("wr1")!;
const rec = buildFinalPregameRecord({ forecast: f, league_slug: "rogers-park", provider: "yahoo", scoring_fingerprint: "fp-std", source_observation_id: srcobs, recorded_at: iso(KICK - 20 * MIN) })!;

console.log(`\\set real_srcobs ${q(srcobs)}`);
console.log(`\\set real_forecast_id ${q(rec.forecast_id)}`);
console.log(`\\set real_signature ${q(rec.content_signature)}`);
console.log(`\\set real_record ${q(JSON.stringify(rec))}`);
console.log(`\\set real_thin_record ${q(JSON.stringify({ ...rec, forecast_snapshot: null }))}`);
console.log(`\\set obs_at ${q(observedAt)}`);
console.log(`\\set composed_at ${q(rec.composed_at)}`);
console.log(`\\set kickoff_at ${q(rec.kickoff_at)}`);
console.log(`\\set record_bytes ${rec ? JSON.stringify(rec).length : 0}`);
