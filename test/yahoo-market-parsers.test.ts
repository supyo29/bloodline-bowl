/**
 * Yahoo acquisition-setting, user-team and pending-claim parsers, on Yahoo's nested positional shapes. Unknown setting names are preserved verbatim, never guessed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { YahooApiError, type YahooFantasyClient } from "../lib/providers/yahoo/client";
import { fetchYahooLeagueSettings } from "../lib/providers/yahoo/fetch";
import { probeUserTeams } from "../lib/providers/yahoo/discovery";
import { readPendingClaims } from "../lib/providers/yahoo/pending-claims";
import { rawLeagueSettings } from "./fixtures/yahoo-raw";

const fake = (routes: (p: string) => unknown): YahooFantasyClient => ({ tokenBackend: "memory", async get(path: string) { const d = routes(path); if (d instanceof Error) throw d; return { data: d, meta: { resource_path: path, http_status: 200, duration_ms: 1, refreshed: false, request_id: null } }; } }) as unknown as YahooFantasyClient;
const settingsWith = (extra: Record<string, unknown>) => { const j = JSON.parse(JSON.stringify(rawLeagueSettings)); Object.assign(j.fantasy_content.league[1].settings[0], extra); return j; };

describe("fetchYahooLeagueSettings: acquisition fields", () => {
  it("keeps waiver_type / waiver_rule verbatim and parses a numeric waiver_time and add limits when stated", async () => {
    const r = await fetchYahooLeagueSettings(fake(() => settingsWith({ waiver_time: "2", max_adds: "40", max_weekly_adds: "4", trade_end_date: "2026-11-20", uses_faab: "1" })), "k");
    assert.equal(r.waiver_type, "FR"); assert.equal(r.waiver_rule, "gametime"); assert.equal(r.waiver_time_days, 2); assert.equal(r.max_adds_season, 40); assert.equal(r.max_adds_weekly, 4); assert.equal(r.uses_faab_stated, true);
    assert.equal(r.acquisition_raw.waiver_rule, "gametime"); assert.equal(r.acquisition_raw.trade_end_date, "2026-11-20"); assert.equal(r.acquisition_raw.waiver_time, "2");
  });
  it("a setting Yahoo does not state is null (never defaulted): no waiver_time -> null days; no uses_faab -> not stated", async () => {
    const j = JSON.parse(JSON.stringify(rawLeagueSettings)); delete j.fantasy_content.league[1].settings[0].uses_faab;
    const r = await fetchYahooLeagueSettings(fake(() => j), "k");
    assert.equal(r.waiver_time_days, null); assert.equal(r.max_adds_season, null); assert.equal(r.uses_faab_stated, null); assert.equal(r.uses_faab, false, "the legacy boolean is unchanged");
  });
  it("an unfamiliar acquisition setting name is preserved verbatim; non-acquisition and structured settings are not swept in", async () => {
    const r = await fetchYahooLeagueSettings(fake(() => settingsWith({ waiver_lock_hour: "10", trade_reject_time: "2", draft_pick_time: "90", cant_cut_list: "yesterday" })), "k");
    assert.equal(r.acquisition_raw.waiver_lock_hour, "10"); assert.equal(r.acquisition_raw.trade_reject_time, "2"); assert.equal("draft_pick_time" in r.acquisition_raw, false);
    assert.ok(!("roster_positions" in r.acquisition_raw) && !("stat_modifiers" in r.acquisition_raw));
  });
});

const usersTeams = (teamNodes: unknown[]) => ({ fantasy_content: { users: { "0": { user: [{ guid: "G" }, { games: { "0": { game: [{ game_key: "470" }, { teams: Object.assign({ count: teamNodes.length }, Object.fromEntries(teamNodes.map((t, i) => [String(i), t]))) }] }, count: 1 } }] }, count: 1 } } });
describe("probeUserTeams", () => {
  it("finds an owned team in Yahoo's NESTED team shape ([[{team_key},...],{...}]) — a one-level merge returned 'owns no team' for a real owner", async () => {
    const nested = { team: [[{ team_key: "470.l.287140.t.4" }, { team_id: "4" }, { name: "Mine" }], { team_standings: {} }] };
    const other = { team: [[{ team_key: "470.l.99999.t.2" }, { team_id: "2" }]] };
    const r = await probeUserTeams(fake((p) => (p.includes("/roster") ? { fantasy_content: {} } : usersTeams([nested, other]))), "470.l.287140");
    assert.deepEqual(r.team_keys, ["470.l.287140.t.4"]); assert.equal(r.roster_readable, true);
  });
  it("also accepts the flat shape, and reports an account with no team in THIS league honestly", async () => {
    assert.deepEqual((await probeUserTeams(fake(() => usersTeams([{ team: [{ team_key: "470.l.287140.t.1" }] }])), "470.l.287140")).team_keys, ["470.l.287140.t.1"]);
    const none = await probeUserTeams(fake(() => usersTeams([{ team: [[{ team_key: "470.l.1.t.1" }]] }])), "470.l.287140"); assert.deepEqual(none.team_keys, []); assert.match(none.detail, /owns no team/);
  });
});

const pending = (rows: Array<{ add?: string; drop?: string; status?: string; bid?: number }>) => ({ fantasy_content: { league: [{ league_key: "470.l.1" }, { transactions: Object.assign({ count: rows.length }, Object.fromEntries(rows.map((r, i) => [String(i), { transaction: [{ transaction_key: `470.l.1.tr.${i}`, transaction_id: String(i), type: "add/drop", status: r.status ?? "pending", timestamp: "1760400000", ...(r.bid != null ? { faab_bid: String(r.bid) } : {}) }, { players: Object.assign({ count: (r.add ? 1 : 0) + (r.drop ? 1 : 0) }, r.add ? { "0": { player: [[{ player_key: r.add }], { transaction_data: [{ type: "add", destination_team_key: "470.l.1.t.4" }] }] } } : {}, r.drop ? { "1": { player: [[{ player_key: r.drop }], { transaction_data: [{ type: "drop", source_team_key: "470.l.1.t.4" }] }] } } : {}) }] }])) ) }] } });
describe("readPendingClaims (read-only; only for an owned team)", () => {
  it("no owned team -> UNAVAILABLE with the real reason, and NO request is made", async () => {
    let n = 0; const r = await readPendingClaims(fake(() => { n += 1; return {}; }), "470.l.1", []); assert.equal(r.visibility, "UNAVAILABLE"); assert.match(r.reason, /owns no team/); assert.equal(n, 0);
  });
  it("parses only PENDING claims (add / drop / bid); processed transactions are ignored", async () => {
    const r = await readPendingClaims(fake(() => pending([{ add: "470.p.1", drop: "470.p.2", bid: 7 }, { add: "470.p.3", status: "successful" }])), "470.l.1", ["470.l.1.t.4"]);
    assert.equal(r.visibility, "AVAILABLE"); assert.deepEqual(r.claims, [{ team_key: "470.l.1.t.4", transaction_key: "470.l.1.tr.0", add_player_key: "470.p.1", drop_player_key: "470.p.2", bid: 7 }]);
  });
  it("an owned team with zero pending claims is AVAILABLE with an empty list (distinct from UNAVAILABLE)", async () => {
    const r = await readPendingClaims(fake(() => pending([])), "470.l.1", ["470.l.1.t.4"]); assert.equal(r.visibility, "AVAILABLE"); assert.deepEqual(r.claims, []);
  });
  it("a failed or unparseable read is UNAVAILABLE, never 'no claims'", async () => {
    assert.equal((await readPendingClaims(fake(() => new YahooApiError("SERVER", "boom", 500, "/x")), "470.l.1", ["t"])).visibility, "UNAVAILABLE");
    assert.equal((await readPendingClaims(fake(() => ({ nope: 1 })), "470.l.1", ["t"])).visibility, "UNAVAILABLE");
  });
});

import { yahooBundleToCanonical, type YahooFlatBundle } from "../lib/providers/yahoo/canonical";
import { PlayerCrosswalk, NoCrosswalk } from "../lib/canonical/players";
describe("the Yahoo canonical league never INVENTS acquisition facts", () => {
  const bundle = (uses_faab: boolean): YahooFlatBundle => ({
    league: { league_key: "470.l.1", league_id: "1", name: "L", season: 2026, current_week: 6, num_teams: 1, scoring_type: "head", stat_modifiers: {}, roster_positions: [{ position: "QB", count: 1 }, { position: "BN", count: 5 }], playoff_start_week: 15, num_playoff_teams: 4, waiver_type: "FR", uses_faab },
    teams: [{ team_key: "470.l.1.t.1", team_id: "1", name: "T", managers: [{ guid: "1", nickname: "m" }], wins: 0, losses: 0, ties: 0, points_for: 0, points_against: 0, faab_balance: 63, waiver_priority: 3, rank: 1, roster: [] }], players: [], transactions: [],
  });
  it("the FAAB budget is UNKNOWN (null), not a hard-coded 100; the team's real remaining balance is preserved", async () => {
    const cw = new PlayerCrosswalk(NoCrosswalk); await cw.ensureLoaded();
    const out = yahooBundleToCanonical("test", bundle(true), cw, null); const snapLeague = (out as unknown as { league: { waiver_settings: { type: string; faab_budget: number | null } } }).league;
    assert.equal(snapLeague.waiver_settings.type, "faab"); assert.equal(snapLeague.waiver_settings.faab_budget, null);
    assert.equal((out as unknown as { teams: Array<{ faab_remaining: number | null }> }).teams[0]!.faab_remaining, 63);
  });
});
