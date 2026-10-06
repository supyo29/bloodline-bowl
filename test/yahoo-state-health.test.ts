/**
 * Yahoo canonical-state health: the exact conditions that made Rogers Park and
 * Maclin report DEGRADED in production, tested at their source.
 *
 *   1. unmapped_yahoo_scoring_stats — live Yahoo category names with no mapping
 *      ("Field Goals Missed 0-19 Yards", "2-Point Conversions", "Return Yards" x2).
 *   2. week_transactions_unavailable — Yahoo transactions carry no fantasy week;
 *      now stamped from Yahoo's own game-week calendar when it fully covers them.
 *   3. a false "cross-surface discrepancy" from Number("470.l.X.t.N") = NaN in
 *      the reconciler (integrity/freshness only).
 *
 * The real YahooProvider runs through the real buildCanonicalLeagueState with
 * Yahoo mocked at `fetch`; READY/PARTIAL comes out of the production logic.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { buildCanonicalLeagueState } from "../lib/canonical/state";
import { reconcilePublishCandidate } from "../lib/canonical/reconcile";
import { teamOrdinal } from "../lib/canonical/certification/harness";
import { PlayerCrosswalk, type CrosswalkSource } from "../lib/canonical/players";
import { YahooProvider } from "../lib/providers/yahoo/provider";
import { clearGameKeyCache } from "../lib/providers/yahoo/games";
import {
  clearGameWeeksCache,
  easternLeagueDay,
  parseGameWeeks,
  weekFilterIsAuthoritative,
  weekForTimestamp,
  type YahooGameWeek,
} from "../lib/providers/yahoo/game-weeks";
import { mapYahooScoringSettings } from "../lib/providers/yahoo/scoring";
import { InMemoryYahooTokenStore } from "../lib/providers/yahoo/oauth";
import {
  rawDraftResults,
  rawLeagueMetadata,
  rawLeagueSettings,
  rawScoreboard,
  rawStandings,
  rawTeamRoster,
  rawTransactionsPage,
  ROGERS_PARK_LEAGUE_KEY as LK,
} from "./fixtures/yahoo-raw";

const ENV = {
  YAHOO_CLIENT_ID: "id",
  YAHOO_CLIENT_SECRET: "secret",
  YAHOO_REDIRECT_URI: "https://x/api/yahoo/oauth/callback",
} as unknown as NodeJS.ProcessEnv;

function store(): InMemoryYahooTokenStore {
  const s = new InMemoryYahooTokenStore();
  void s.set({ access_token: "A", refresh_token: "R", token_type: "bearer", scope: "fspt-r", expires_at: Date.now() + 3_600_000, yahoo_guid: "G" });
  return s;
}

// --- Yahoo game-week calendar fixture (contiguous Tue..Mon weeks, week 1 starts Thu) ---
function calendarBody(weeks: Array<[number, string, string]>) {
  const gw: Record<string, unknown> = { count: weeks.length };
  weeks.forEach(([week, start, end], i) => (gw[String(i)] = { game_week: { week: String(week), display_name: String(week), start, end } }));
  return { fantasy_content: { game: [{ game_key: "471", code: "nfl", season: "2026" }, { game_weeks: gw }] } };
}
const CALENDAR: Array<[number, string, string]> = [
  [1, "2026-09-10", "2026-09-14"],
  [2, "2026-09-15", "2026-09-21"],
  [3, "2026-09-22", "2026-09-28"],
  [4, "2026-09-29", "2026-10-05"],
];
const WEEKS: YahooGameWeek[] = parseGameWeeks(calendarBody(CALENDAR));
const ts = (isoUtc: string) => Math.floor(Date.parse(isoUtc) / 1000);

describe("Yahoo game-week calendar", () => {
  it("parses Yahoo's game_weeks collection", () => {
    assert.deepEqual(WEEKS.map((w) => [w.week, w.start, w.end]), CALENDAR);
  });

  it("assigns weeks by US-Eastern league day (a Tuesday 01:00 UTC transaction is still Monday in ET)", () => {
    assert.equal(easternLeagueDay(ts("2026-09-29T01:00:00Z")), "2026-09-28");
    assert.equal(weekForTimestamp(WEEKS, ts("2026-09-29T01:00:00Z")), 3);
    assert.equal(weekForTimestamp(WEEKS, ts("2026-09-29T15:00:00Z")), 4);
    assert.equal(weekForTimestamp(WEEKS, Number.NaN), null);
  });

  it("a week filter is authoritative only when every transaction is placed or predates week 1", () => {
    const placed = { fantasy_week: 3, timestamp_seconds: ts("2026-09-23T12:00:00Z") };
    const preseason = { fantasy_week: null, timestamp_seconds: ts("2026-08-30T12:00:00Z") };
    const afterCalendar = { fantasy_week: null, timestamp_seconds: ts("2026-10-20T12:00:00Z") };
    assert.equal(weekFilterIsAuthoritative(WEEKS, 3, [placed, preseason]), true);
    assert.equal(weekFilterIsAuthoritative(WEEKS, 3, [placed, afterCalendar]), false, "unplaced in-season transaction");
    assert.equal(weekFilterIsAuthoritative(WEEKS, 9, [placed]), false, "requested week not in calendar");
    assert.equal(weekFilterIsAuthoritative([], 3, [placed]), false, "no calendar");
  });
});

describe("Yahoo scoring: live category names map exactly (no guessing)", () => {
  it("maps the plural 'Field Goals Missed …' names Yahoo actually serves", () => {
    const r = mapYahooScoringSettings(
      [
        { stat_id: "24", name: "Field Goals Missed 0-19 Yards", display_name: "FGM 0-19", position_type: "K" },
        { stat_id: "25", name: "Field Goals Missed 20-29 Yards", display_name: "FGM 20-29", position_type: "K" },
      ],
      [
        { stat_id: "24", value: -3 },
        { stat_id: "25", value: -2 },
      ],
    );
    assert.deepEqual(r.unmapped, []);
    assert.equal(r.raw_scoring.fgmiss_0_19, -3);
    assert.equal(r.raw_scoring.fgmiss_20_29, -2);
  });

  it("expands generic 2-Point Conversions into pass/rush/rec at the same value; a specific category wins", () => {
    const generic = mapYahooScoringSettings([{ stat_id: "16", name: "2-Point Conversions", display_name: "2-PT", position_type: "O" }], [{ stat_id: "16", value: 2 }]);
    assert.deepEqual(generic.unmapped, []);
    assert.deepEqual(
      { p: generic.raw_scoring.pass_2pt, r: generic.raw_scoring.rush_2pt, c: generic.raw_scoring.rec_2pt },
      { p: 2, r: 2, c: 2 },
    );
    const withSpecific = mapYahooScoringSettings(
      [
        { stat_id: "16", name: "2-Point Conversions", display_name: "2-PT", position_type: "O" },
        { stat_id: "99", name: "Passing 2-Point Conversions", display_name: null, position_type: "O" },
      ],
      [
        { stat_id: "16", value: 2 },
        { stat_id: "99", value: 3 },
      ],
    );
    assert.equal(withSpecific.raw_scoring.pass_2pt, 3, "explicit passing rule is never overwritten by the generic one");
    assert.equal(withSpecific.raw_scoring.rec_2pt, 2);
  });

  it("disambiguates Return Yards by Yahoo position_type; unknown scope stays unmapped (warned)", () => {
    const r = mapYahooScoringSettings(
      [
        { stat_id: "15", name: "Return Yards", display_name: "Ret Yds", position_type: "O" },
        { stat_id: "50", name: "Return Yards", display_name: "Ret Yds", position_type: "DT" },
        { stat_id: "77", name: "Return Yards", display_name: "Ret Yds" },
      ],
      [
        { stat_id: "15", value: 0.04 },
        { stat_id: "50", value: 0.03 },
        { stat_id: "77", value: 0.05 },
      ],
    );
    assert.equal(r.raw_scoring.kr_yd, 0.04);
    assert.equal(r.raw_scoring.pr_yd, 0.04);
    assert.equal(r.raw_scoring.def_kr_yd, 0.03);
    assert.equal(r.raw_scoring.def_pr_yd, 0.03);
    assert.deepEqual(r.unmapped.map((u) => u.stat_id), ["77"]);
    assert.equal(r.raw_scoring.yahoo_stat_77, 0.05);
  });

  it("the exact production-unmapped sets for Rogers Park and Maclin now map completely", () => {
    const maclin = mapYahooScoringSettings(
      [
        { stat_id: "15", name: "Return Yards", display_name: null, position_type: "O" },
        { stat_id: "16", name: "2-Point Conversions", display_name: null, position_type: "O" },
        { stat_id: "24", name: "Field Goals Missed 0-19 Yards", display_name: null, position_type: "K" },
        { stat_id: "25", name: "Field Goals Missed 20-29 Yards", display_name: null, position_type: "K" },
        { stat_id: "50", name: "Return Yards", display_name: null, position_type: "DT" },
      ],
      ["15", "16", "24", "25", "50"].map((stat_id) => ({ stat_id, value: 1 })),
    );
    assert.deepEqual(maclin.unmapped, []);
    const rogers = mapYahooScoringSettings([{ stat_id: "16", name: "2-Point Conversions", display_name: null, position_type: "O" }], [{ stat_id: "16", value: 2 }]);
    assert.deepEqual(rogers.unmapped, []);
  });
});

describe("reconciler team keys (false cross-surface discrepancy)", () => {
  it("Yahoo team keys resolve to their team ordinal; Sleeper numeric roster ids are unchanged", () => {
    assert.equal(teamOrdinal("470.l.287140.t.4"), 4);
    assert.equal(teamOrdinal("470.l.82713.t.10"), 10);
    assert.equal(teamOrdinal("7"), 7);
    assert.equal(teamOrdinal(null), 0, "unchanged legacy behavior for null (Number(null) === 0)");
    assert.ok(Number.isNaN(teamOrdinal("not-a-team")));
  });
});

// --- full canonical state through the real Yahoo provider ----------------------------
const T1 = `${LK}.t.1`;
const T2 = `${LK}.t.2`;
const PLAYERS = [
  { key: "471.p.33040", id: "33040", name: "Josh Allen", team: "BUF", pos: "QB" },
  { key: "471.p.28392", id: "28392", name: "Derrick Henry", team: "BAL", pos: "RB" },
];

function settingsWith(transform: (stats: Array<{ stat: Record<string, unknown> }>) => void) {
  const body = structuredClone(rawLeagueSettings) as unknown;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (rec.stat_categories && rec.stat_modifiers) {
      const cats = (rec.stat_categories as { stats: Array<{ stat: Record<string, unknown> }> }).stats;
      const mods = (rec.stat_modifiers as { stats: Array<{ stat: Record<string, unknown> }> }).stats;
      transform(cats);
      // keep only modifiers whose category survived, plus any new ones (value 1)
      const ids = new Set(cats.map((c) => String(c.stat.stat_id)));
      const existing = new Set(mods.map((m) => String(m.stat.stat_id)));
      for (let i = mods.length - 1; i >= 0; i--) if (!ids.has(String(mods[i]!.stat.stat_id))) mods.splice(i, 1);
      for (const id of ids) if (!existing.has(id)) mods.push({ stat: { stat_id: id, value: "1" } });
      return;
    }
    for (const v of Object.values(rec)) visit(v);
  };
  visit(body);
  return body;
}

const playersBody = () => ({
  fantasy_content: {
    players: {
      ...Object.fromEntries(
        PLAYERS.map((p, i) => [
          String(i),
          { player: [[{ player_key: p.key }, { player_id: p.id }, { name: { full: p.name } }, { editorial_team_abbr: p.team }, { display_position: p.pos }, { eligible_positions: [{ position: p.pos }] }]] },
        ]),
      ),
      count: PLAYERS.length,
    },
  },
});

interface Opts {
  calendar?: Array<[number, string, string]> | null;
  settings?: unknown;
  txTimestamp?: number;
}

function stubYahoo(opts: Opts = {}): string[] {
  const urls: string[] = [];
  const settings = opts.settings ?? settingsWith((cats) => cats.splice(cats.findIndex((c) => /Tackle for Loss/i.test(String(c.stat.name))), 1));
  const tx = rawTransactionsPage([
    { key: `${LK}.tr.53`, id: "53", type: "add/drop", ts: opts.txTimestamp ?? ts("2026-09-23T16:00:00Z"), adds: [{ key: "471.p.33040", dest: T1 }], drops: [{ key: "471.p.28392", src: T1 }] },
  ]);
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 });
    if (url.includes("/games;")) return json({ fantasy_content: { games: { "0": { game: [{ game_key: "471", game_id: "471", code: "nfl", season: "2026" }] }, count: 1 } } });
    if (url.includes("/game/471/game_weeks")) return opts.calendar === null ? new Response("nope", { status: 404 }) : json(calendarBody(opts.calendar ?? CALENDAR));
    if (url.includes("/metadata")) return json(rawLeagueMetadata);
    if (url.includes("/settings")) return json(settings);
    if (url.includes("/standings")) return json(rawStandings);
    if (url.includes(`/team/${T1}/roster`)) return json(rawTeamRoster(T1, [{ ...PLAYERS[0]!, slot: "QB" }]));
    if (url.includes(`/team/${T2}/roster`)) return json(rawTeamRoster(T2, [{ ...PLAYERS[1]!, slot: "RB" }]));
    if (url.includes("/draftresults")) return json(rawDraftResults);
    if (url.includes("/scoreboard;week=")) return json(rawScoreboard(3, [{ team_key: T1, points: 101.5 }, { team_key: T2, points: 99.2 }]));
    if (url.includes("/transactions")) return json(tx);
    if (url.includes("/players;player_keys=")) return json(playersBody());
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return urls;
}

const crosswalkSource: CrosswalkSource = {
  name: "test",
  load: async () => PLAYERS.map((p) => ({ yahoo_id: p.id, yahoo_player_key: p.key, sleeper_id: `s${p.id}`, full_name: p.name, position: p.pos, nfl_team: p.team })),
};

async function rogersState() {
  return buildCanonicalLeagueState("rogers-park", {
    providerOverride: new YahooProvider({ env: ENV, tokenStore: store() }),
    crosswalkOverride: await PlayerCrosswalk.create(crosswalkSource),
    reportPersistence: false,
    bypassScope: true,
  });
}

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  clearGameKeyCache();
  clearGameWeeksCache();
});

describe("Yahoo canonical state health (real provider + real state builder)", () => {
  it("healthy live data, fully mapped scoring, calendar covering transactions -> live READY with no warnings", async () => {
    stubYahoo();
    const r = await rogersState();
    assert.ok(r.snapshot, JSON.stringify(r).slice(0, 300));
    assert.deepEqual(r.snapshot!.warnings, []);
    assert.equal(r.snapshot!.live_provider_status, "READY");
    // recent transactions are the current week's (week 3 from metadata) and stamped
    assert.ok(r.snapshot!.recent_transactions.every((t) => t.fantasy_week === r.snapshot!.week));
    // and the snapshot reconciles cleanly (no false NaN discrepancy)
    const rec = reconcilePublishCandidate(r.snapshot!);
    assert.deepEqual(rec.discrepancies, []);
  });

  it("calendar unavailable -> PARTIAL with exactly week_transactions_unavailable (truly missing data still degrades)", async () => {
    stubYahoo({ calendar: null });
    const r = await rogersState();
    assert.equal(r.snapshot!.live_provider_status, "PARTIAL");
    assert.deepEqual(r.snapshot!.warnings.map((w) => w.code), ["week_transactions_unavailable"]);
  });

  it("an in-season transaction outside every calendar window -> PARTIAL (never a silently filtered feed)", async () => {
    stubYahoo({ calendar: [[1, "2026-09-10", "2026-09-14"], [3, "2026-09-29", "2026-10-05"]], txTimestamp: ts("2026-09-17T16:00:00Z") });
    const r = await rogersState();
    assert.deepEqual(r.snapshot!.warnings.map((w) => w.code), ["week_transactions_unavailable"]);
    assert.equal(r.snapshot!.recent_transactions.length, 1, "unverifiable filter returns the feed, not an empty list");
  });

  it("a genuinely unmappable scoring category -> PARTIAL with exactly unmapped_yahoo_scoring_stats", async () => {
    stubYahoo(); // default settings keep "Tackle for Loss Bonus" removed; re-add an ambiguous one:
    stubYahoo({ settings: settingsWith((cats) => cats.push({ stat: { stat_id: "77", name: "Return Yards", display_name: "Ret Yds" } })) });
    const r = await rogersState();
    assert.equal(r.snapshot!.live_provider_status, "PARTIAL");
    assert.ok(r.snapshot!.warnings.some((w) => w.code === "unmapped_yahoo_scoring_stats"));
    assert.ok(!r.snapshot!.warnings.some((w) => w.code === "week_transactions_unavailable"));
  });

  it("transaction route health matches canonical: the provider week filter is the same code path", async () => {
    stubYahoo();
    const provider = new YahooProvider({ env: ENV, tokenStore: store() });
    const ctx = { league_slug: "rogers-park", external_league_id: "287140", season: 2026, crosswalk: await PlayerCrosswalk.create(crosswalkSource) };
    const wk3 = await provider.getTransactions(ctx, { week: 3 });
    const wk4 = await provider.getTransactions(ctx, { week: 4 });
    assert.equal(wk3.data!.length, 1);
    assert.deepEqual(wk3.warnings, []);
    assert.equal(wk4.data!.length, 0, "authoritative empty week, not a dropped warning");
    assert.deepEqual(wk4.warnings, []);
    const all = await provider.getTransactions(ctx);
    assert.equal(all.data![0]!.fantasy_week, 3, "unfiltered reads also carry the stamped week");
  });
});

describe("league isolation of canonical / persistence keys", () => {
  it("Rogers Park and Maclin produce disjoint, slug-scoped transaction and team ids", async () => {
    stubYahoo();
    const provider = new YahooProvider({ env: ENV, tokenStore: store() });
    const cw = await PlayerCrosswalk.create(crosswalkSource);
    const rp = await provider.getTransactions({ league_slug: "rogers-park", external_league_id: "287140", season: 2026, crosswalk: cw });
    const mc = await provider.getTransactions({ league_slug: "maclin-on-chicks-xvi", external_league_id: "287140", season: 2026, crosswalk: cw });
    const ids = (r: typeof rp) => r.data!.flatMap((t) => [t.canonical_transaction_id, ...t.canonical_team_ids]);
    assert.ok(ids(rp).every((id) => id.includes("rogers-park")));
    assert.ok(ids(mc).every((id) => id.includes("maclin-on-chicks-xvi")));
    assert.equal(ids(rp).filter((id) => ids(mc).includes(id)).length, 0);
  });
});
