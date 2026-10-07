/**
 * W1.R1 P1-3 reproduction: does a Yahoo-rostered team defense join the projection feed's defense row (through the real weekly provider)?
 * Crosswalk has NO defense rows (nfl_players holds individuals only) — the production-expected state. Runs unchanged on 65a04f4 and the fixed tree.
 * Run:  node --import tsx scripts/w1r1-repros/p1-3-yahoo-defense.ts
 */
import { PlayerCrosswalk } from "@/lib/canonical/players";
import { clearProjectionFeedCache } from "@/lib/sleeper/client";
import { SleeperWeeklyProjectionProvider } from "@/lib/weekly/projections/sleeper-weekly";

const feedRow = (id: string, position: string, first: string, last: string, team: string, stats: Record<string, number>) => ({
  player_id: id, team, opponent: "LV", season: "2026", season_type: "regular", week: 5, category: "proj", company: "rotowire",
  last_modified: 1, updated_at: 1, stats, player: { first_name: first, last_name: last, position, team, injury_status: null, fantasy_positions: [position] },
});
const FEED = [
  feedRow("BAL", "DEF", "Baltimore", "Ravens", "BAL", { pts_std: 8 }),
  feedRow("GB", "DEF", "Green Bay", "Packers", "GB", { pts_std: 6 }),
  feedRow("wr1", "WR", "Jane", "Wideout", "KC", { rec: 6, rec_yd: 80, rec_td: 0.5 }),
];
const crosswalk = new PlayerCrosswalk({ name: "no-defense-rows", load: async () => [{ gsis_id: "00-1", sleeper_id: "wr1", yahoo_id: "9001", full_name: "Jane Wideout", position: "WR", nfl_team: "KC" } as never] } as never);

(async () => {
  clearProjectionFeedCache();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    const want = u.searchParams.getAll("position[]");
    return new Response(JSON.stringify(FEED.filter((r) => want.length === 0 || want.includes(r.player.position))), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await crosswalk.ensureLoaded();
    const yahooDef = (name: string, key: string, abbr: string) =>
      crosswalk.resolve({ provider: "yahoo", provider_player_id: `nfl.p.${key}`, full_name: name, position: "DEF", nfl_team: abbr, known_identifiers: { yahoo_id: key, yahoo_player_key: `nfl.p.${key}` } }).player;
    const maclin = yahooDef("Baltimore", "100022", "Bal"); // rostered in maclin-on-chicks-xvi
    const rogers = yahooDef("Green Bay", "100011", "GB"); // rostered in rogers-park
    const sleeperBal = crosswalk.resolve({ provider: "sleeper", provider_player_id: "BAL", full_name: "Baltimore Ravens", position: "DEF", nfl_team: "BAL" }).player;
    const scoring = { rec: 1, rec_yd: 0.1, rec_td: 6 };
    const batchFor = async (slug: string, ids: string[]) =>
      new SleeperWeeklyProjectionProvider().getWeeklyProjections({ league: { league_slug: slug, season: 2026, raw_scoring: scoring, scoring_rules: [] }, week: 5, crosswalk, canonical_player_ids: ids, want_rest_of_season: false });
    const a = await batchFor("maclin-on-chicks-xvi", [maclin.canonical_player_id]);
    const b = await batchFor("rogers-park", [rogers.canonical_player_id]);
    console.log(JSON.stringify({
      p1: "P1-3",
      yahoo_BAL_canonical_id: maclin.canonical_player_id,
      sleeper_BAL_canonical_id: sleeperBal.canonical_player_id,
      same_entity: maclin.canonical_player_id === sleeperBal.canonical_player_id,
      maclin_defense_projection: a.by_player.get(maclin.canonical_player_id)?.projected_points ?? null,
      maclin_defense_missing: a.missing.includes(maclin.canonical_player_id),
      rogers_defense_projection: b.by_player.get(rogers.canonical_player_id)?.projected_points ?? null,
      rogers_defense_missing: b.missing.includes(rogers.canonical_player_id),
    }));
  } finally {
    globalThis.fetch = realFetch;
    clearProjectionFeedCache();
  }
})();
