/**
 * Four-league isolation — deterministic (no network).
 *
 *   Sleeper: bloodline-bowl, devoted-to-the-game
 *   Yahoo:   maclin-on-chicks-xvi, rogers-park
 *
 * Proves the initial registry delivers: 4 leagues · 2 providers · 3 known
 * manager contexts · 1 shared canonical architecture, with no cross-league
 * contamination and no provider-native id leaking into the analytical identity.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  findLeagueTarget,
  getLeagueRegistry,
  leagueConfigStatus,
  listLeagueTargets,
} from "../lib/leagues/registry";
import { resolveLeagueStrict } from "../lib/leagues/resolve";
import { buildCanonicalLeagueState } from "../lib/canonical/state";
import { PlayerCrosswalk, NoCrosswalk } from "../lib/canonical/players";
import { yahooBundleToCanonical } from "../lib/providers/yahoo/canonical";
import { MemoryLedgerStore, MemorySnapshotStore } from "../lib/persistence/memory";
import {
  CANONICAL_SCHEMA_VERSION,
  type CanonicalLeagueSnapshot,
  type CanonicalTransaction,
} from "../lib/canonical/schema";
import { yahooFixture, rogersParkFixture, YAHOO_LEAGUE_FIXTURES } from "./fixtures/yahoo";

const SLEEPER = ["bloodline-bowl", "devoted-to-the-game"] as const;
const YAHOO = ["maclin-on-chicks-xvi", "rogers-park"] as const;
const ALL = [...SLEEPER, ...YAHOO];
const BASE = { reportPersistence: false as const, crosswalkOverride: new PlayerCrosswalk(NoCrosswalk) };

/* --------------------------------------------------------------- registry */

describe("registry: 4 leagues · 2 providers · 3 known manager contexts", () => {
  it("contains exactly the four initial leagues, no warnings", () => {
    const { targets, warnings } = getLeagueRegistry();
    assert.deepEqual(warnings, []);
    assert.deepEqual(targets.map((t) => t.key).sort(), [...ALL].sort());
  });

  it("providers: bloodline/devoted = sleeper; maclin/rogers-park = yahoo", () => {
    for (const slug of SLEEPER) assert.equal(findLeagueTarget(slug)!.provider, "sleeper");
    for (const slug of YAHOO) assert.equal(findLeagueTarget(slug)!.provider, "yahoo");
  });

  it("rogers-park is registered independently of maclin-on-chicks-xvi", () => {
    const rp = findLeagueTarget("rogers-park")!;
    const mc = findLeagueTarget("maclin-on-chicks-xvi")!;
    assert.equal(rp.external_league_id, "287140");
    assert.equal(mc.external_league_id, "82713");
    assert.notEqual(rp.external_league_id, mc.external_league_id);
    assert.equal(rp.season, 2026);
    assert.equal(leagueConfigStatus(rp), "AWAITING_CREDENTIALS");
    assert.equal(leagueConfigStatus(mc), "AWAITING_CREDENTIALS");
  });

  it("exactly 3 known manager contexts across all leagues", () => {
    const known = listLeagueTargets().flatMap((t) => t.known_managers);
    assert.deepEqual(known.sort(), ["bijimac", "darthmarker", "supyo29"]);
    for (const slug of YAHOO) assert.deepEqual(findLeagueTarget(slug)!.known_managers, []);
  });
});

/* ------------------------------------------------------------- routing */

describe("path routing resolves all four leagues to the right provider", () => {
  for (const slug of ALL) {
    it(`resolveLeagueStrict("${slug}") resolves (registered), never 404`, () => {
      const r = resolveLeagueStrict(slug);
      assert.equal(r.ok, true);
      assert.equal(r.ok && r.league.registered, true);
      assert.equal(r.ok && r.league.league_slug, slug);
    });
  }

  it("rogers-park + maclin both resolve to the yahoo provider", () => {
    for (const slug of YAHOO) {
      const r = resolveLeagueStrict(slug);
      assert.equal(r.ok && r.league.provider, "yahoo");
    }
  });

  it("/api/league/rogers-park/state returns an explicit pre-auth state, NOT a 404", async () => {
    const r = await buildCanonicalLeagueState("rogers-park", BASE);
    assert.equal(r.status, 200);
    assert.ok(["NOT_CONFIGURED", "AUTH_REQUIRED"].includes(r.snapshot!.live_provider_status));
    assert.equal(r.snapshot!.teams.length, 0, "no fabricated data pre-auth");
    // The canonical identity is the slug, never Yahoo's 287140.
    assert.equal(r.snapshot!.league.league_slug, "rogers-park");
    assert.equal(r.snapshot!.league.canonical_league_id, "league:rogers-park");
  });

  it("an unknown league is still a clean 404", async () => {
    const r = await buildCanonicalLeagueState("logan-square", BASE);
    assert.equal(r.status, 404);
  });
});

/* ------------------------------------------- Yahoo fixture: two independent leagues */

function toCanon(slug: string, fixture: typeof yahooFixture): ReturnType<typeof yahooBundleToCanonical> {
  return yahooBundleToCanonical(slug, fixture, new PlayerCrosswalk(NoCrosswalk), "2026-01-01T00:00:00Z");
}

describe("Yahoo adapter supports MULTIPLE leagues (not one hard-coded fixture)", () => {
  const maclin = toCanon("maclin-on-chicks-xvi", yahooFixture);
  const rogers = toCanon("rogers-park", rogersParkFixture);

  it("two fixtures are exported and independently identifiable", () => {
    assert.equal(Object.keys(YAHOO_LEAGUE_FIXTURES).length, 2);
    assert.notEqual(yahooFixture.league.league_key, rogersParkFixture.league.league_key);
    assert.notEqual(yahooFixture.league.league_id, rogersParkFixture.league.league_id);
  });

  it("canonical league identity is the SLUG — Yahoo's provider id never becomes the identity", () => {
    assert.equal(maclin.league.canonical_league_id, "league:maclin-on-chicks-xvi");
    assert.equal(rogers.league.canonical_league_id, "league:rogers-park");
    // The human-facing / provider key must not appear in the canonical id.
    assert.ok(!maclin.league.canonical_league_id.includes("82713"));
    assert.ok(!rogers.league.canonical_league_id.includes("287140"));
    assert.ok(!rogers.league.canonical_league_id.includes("449.l."));
    // But provenance still preserves the provider key.
    assert.equal(rogers.league.provenance.provider_id, "449.l.287140");
  });

  it("no team / manager / player / transaction id is shared between the two Yahoo leagues", () => {
    const ids = (c: typeof maclin) => [
      ...c.teams.map((t) => t.canonical_team_id),
      ...c.managers.map((m) => m.canonical_manager_id),
      ...c.players.map((p) => p.canonical_player_id),
      ...c.transactions.map((t) => t.canonical_transaction_id),
    ];
    const maclinIds = new Set(ids(maclin));
    for (const id of ids(rogers)) {
      assert.ok(!maclinIds.has(id), `shared id leaked across Yahoo leagues: ${id}`);
    }
  });

  it("every canonical entity in each league carries that league's id", () => {
    for (const [slug, c] of [["maclin-on-chicks-xvi", maclin], ["rogers-park", rogers]] as const) {
      assert.ok(c.teams.every((t) => t.canonical_team_id.startsWith(`team:${slug}:`)));
      assert.ok(c.transactions.every((t) => t.canonical_league_id === `league:${slug}` && t.league_slug === slug));
    }
  });

  it("the two leagues have different scoring (rec: 0.5 vs 1) — no shared config", () => {
    assert.notEqual(maclin.league.raw_scoring.rec, rogers.league.raw_scoring.rec);
  });
});

/* ---------------------------------------------- persistence isolation (4 leagues) */

function snap(slug: string, week: number): CanonicalLeagueSnapshot {
  const provider = slug.startsWith("bloodline") || slug.startsWith("devoted") ? "sleeper" : "yahoo";
  return {
    schema_version: CANONICAL_SCHEMA_VERSION,
    captured_at: new Date().toISOString(),
    provider_synced_at: null,
    league: {
      canonical_league_id: `league:${slug}`,
      league_slug: slug,
      name: slug,
      season: 2026,
      status: "in_season",
      sport: "nfl",
      team_count: 2,
      current_week: week,
      scoring_rules: [],
      raw_scoring: {},
      roster_settings: { starting_slots: [], bench_slots: 0, ir_slots: 0, taxi_slots: 0, slot_requirements: {} },
      playoff_settings: { playoff_team_count: null, playoff_start_week: null, championship_week: null },
      waiver_settings: { type: "unknown", faab_budget: null, waiver_day: null },
      provenance: { provider, provider_id: slug, provider_synced_at: null },
    },
    season: 2026,
    week,
    managers: [],
    teams: [],
    rosters: [],
    standings: [],
    matchups: [],
    recent_transactions: [],
    draft_picks: [],
    waiver_state: null,
    players: [],
    unresolved_players: [],
    live_provider_status: "READY",
    history_persistence_status: "READY",
    warnings: [],
  };
}

function txn(slug: string, id: string): CanonicalTransaction {
  const provider = slug.startsWith("bloodline") || slug.startsWith("devoted") ? "sleeper" : "yahoo";
  return {
    canonical_transaction_id: `txn:${provider}:${slug}:2026:${id}`,
    canonical_league_id: `league:${slug}`,
    league_slug: slug,
    season: 2026,
    type: "trade",
    status: "complete",
    provider_timestamp: "2026-09-10T00:00:00Z",
    fantasy_week: 2,
    canonical_team_ids: [`team:${slug}:1`],
    players_added: [],
    players_dropped: [],
    trade_legs: [],
    faab_spent: null,
    provenance: { provider, provider_id: id, provider_synced_at: null },
    source_metadata: {},
  };
}

describe("persistence: snapshots + ledger isolated by canonical league slug (all 4)", () => {
  it("a snapshot write to one league never appears under another", async () => {
    const store = new MemorySnapshotStore();
    for (const slug of ALL) await store.put(snap(slug, 1), { capture_type: "FINAL" });
    for (const slug of ALL) {
      const weeks = await store.listWeeks(slug, 2026);
      assert.equal(weeks.length, 1);
      assert.equal(weeks[0]!.league_slug, slug);
      const latest = await store.getLatest({ league_slug: slug, season: 2026, week: 1 });
      assert.equal(latest!.payload.league.league_slug, slug);
    }
  });

  it("rogers-park week 1 and maclin week 1 are separate rows; neither overwrites the other", async () => {
    const store = new MemorySnapshotStore();
    await store.put(snap("rogers-park", 1), { capture_type: "FINAL" });
    await store.put(snap("maclin-on-chicks-xvi", 1), { capture_type: "FINAL" });
    assert.equal((await store.listWeeks("rogers-park", 2026)).length, 1);
    assert.equal((await store.listWeeks("maclin-on-chicks-xvi", 2026)).length, 1);
  });

  it("transaction records are isolated by canonical league slug", async () => {
    const ledger = new MemoryLedgerStore();
    await ledger.append(ALL.flatMap((slug) => [txn(slug, "a"), txn(slug, "b")]));
    for (const slug of ALL) {
      const rows = await ledger.query({ league_slug: slug, season: 2026 });
      assert.equal(rows.length, 2);
      assert.ok(rows.every((r) => r.league_slug === slug && r.payload.canonical_league_id === `league:${slug}`));
    }
    // A shared provider_transaction_id "a" across leagues is NOT a collision —
    // the idempotency key is scoped by league_slug.
    assert.equal(await ledger.count("rogers-park", 2026), 2);
    assert.equal(await ledger.count("maclin-on-chicks-xvi", 2026), 2);
  });

  it("re-syncing rogers-park does not touch maclin rows (idempotent + isolated)", async () => {
    const ledger = new MemoryLedgerStore();
    await ledger.append([txn("maclin-on-chicks-xvi", "x")]);
    const first = await ledger.append([txn("rogers-park", "x"), txn("rogers-park", "y")]);
    const second = await ledger.append([txn("rogers-park", "x"), txn("rogers-park", "y")]);
    assert.equal(first.inserted, 2);
    assert.equal(second.inserted, 0);
    assert.equal(await ledger.count("maclin-on-chicks-xvi", 2026), 1);
    assert.equal(await ledger.count("rogers-park", 2026), 2);
  });
});
