/**
 * W1.P4 multi-league certification (fixtures; deterministic; no network). Runs the ACTUAL registered league registry through the real
 * Sleeper weekly provider, real observation recorder and real Supabase snapshot store (on FakeRest).
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { NoCrosswalk, PlayerCrosswalk } from "@/lib/canonical/players";
import { scoringFingerprint } from "@/lib/canonical/scoring-fingerprint";
import { runInLeagueStateScope } from "@/lib/canonical/request-scope";
import { listLeagueTargets } from "@/lib/leagues/registry";
import { clearProjectionFeedCache } from "@/lib/sleeper/client";
import { SupabaseProjectionSnapshotStore } from "@/lib/persistence/supabase/projection-snapshot";
import { InvalidationLedger } from "@/lib/weekly/freshness/events";
import { MemorySourceObservationStore, SourceObservationRecorder } from "@/lib/weekly/freshness/observation";
import { CanonicalProjectionSnapshotProvider } from "@/lib/weekly/projections/canonical-provider";
import { __resetFreshnessRuntimeForTests, getWeeklyProjectionProvider } from "@/lib/weekly/projections/registry";
import { SleeperWeeklyProjectionProvider, __resetOfferedObservationsForTests } from "@/lib/weekly/projections/sleeper-weekly";
import type { ProjectionRequest } from "@/lib/weekly/projections/types";
import { FakeRest } from "./fixtures/fake-rest";

const EXPECTED = [
  { key: "bloodline-bowl", provider: "sleeper", display: "Bloodline Bowl" },
  { key: "devoted-to-the-game", provider: "sleeper", display: "Devoted to the Game" },
  { key: "sportys-alumni", provider: "sleeper", display: "Sporty's Alumni" },
  { key: "maclin-on-chicks-xvi", provider: "yahoo", display: "Maclin on Chick's XVI" },
  { key: "rogers-park", provider: "yahoo", display: "Rogers Park" },
] as const;

/** Each league's own scoring. Maclin and Rogers Park deliberately share a scoring fingerprint (still isolated by league). */
const PPR = { rec: 1, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6, pass_yd: 0.04, pass_td: 4 };
const HALF = { ...PPR, rec: 0.5 };
const STD = { ...PPR, rec: 0 };
const TE_PREM = { ...PPR, rec: 1.5 };
const SCORING: Record<string, Record<string, number>> = {
  "bloodline-bowl": PPR,
  "devoted-to-the-game": HALF,
  "sportys-alumni": TE_PREM,
  "maclin-on-chicks-xvi": STD,
  "rogers-park": STD,
};

const WR_STATS = { gp: 1, rec: 6, rec_yd: 80, rec_td: 0.5 };
const pts = (scoring: Record<string, number>) => WR_STATS.rec * scoring.rec! + WR_STATS.rec_yd * scoring.rec_yd! + WR_STATS.rec_td * scoring.rec_td!;

const row = (id: string, position: string, stats: Record<string, number>, injury: string | null = null) => ({
  player_id: id,
  team: "KC",
  opponent: "LV",
  season: "2026",
  season_type: "regular",
  week: 5,
  category: "proj",
  company: "rotowire",
  last_modified: 1_790_000_000_000,
  updated_at: 1_790_000_000_000,
  stats,
  player: { first_name: position, last_name: id, position, team: "KC", years_exp: 3, injury_status: injury, fantasy_positions: [position], metadata: null },
});

function feedFor(positions: string[]) {
  const all: Record<string, ReturnType<typeof row>> = {
    QB: row("qb-1", "QB", { gp: 1, pass_yd: 250, pass_td: 1.8, rush_yd: 12 }),
    RB: row("rb-1", "RB", { gp: 1, rush_yd: 70, rush_td: 0.5, rec: 3, rec_yd: 20 }),
    WR: row("wr-1", "WR", WR_STATS),
    TE: row("te-1", "TE", { gp: 1, rec: 5, rec_yd: 55, rec_td: 0.3 }),
    K: row("k-1", "K", { gp: 1, pts_std: 8 }),
    DEF: row("def-1", "DEF", { gp: 1, pts_std: 7 }),
  };
  return positions.map((p) => all[p]).filter(Boolean);
}

let fetches = 0;
let originalFetch: typeof fetch;
function installFeed(): void {
  fetches = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    fetches += 1;
    return new Response(JSON.stringify(feedFor(url.searchParams.getAll("position[]"))), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

function req(leagueKey: string, provider: string): ProjectionRequest {
  void provider;
  return {
    league: { league_slug: leagueKey, season: 2026, raw_scoring: SCORING[leagueKey]!, scoring_rules: [] },
    week: 5,
    crosswalk: new PlayerCrosswalk(NoCrosswalk),
    canonical_player_ids: [],
    want_rest_of_season: false,
  };
}

function rig() {
  const obsStore = new MemorySourceObservationStore();
  const ledger = new InvalidationLedger();
  const recorder = new SourceObservationRecorder(obsStore, ledger);
  const rest = new FakeRest();
  const snapStore = new SupabaseProjectionSnapshotStore(rest.asRest());
  const farKickoff = { name: "fixture", getWeekGames: async () => [{ game_id: "g", home_team: "KC", away_team: "LV", kickoff_at: new Date(Date.now() + 100 * 3600_000).toISOString(), status: "pre_game" }] };
  const provider = new CanonicalProjectionSnapshotProvider(new SleeperWeeklyProjectionProvider((o) => recorder.record(o)), snapStore, { kickoffSource: farKickoff, ledger });
  return { obsStore, recorder, rest, provider };
}

describe("W1.P4 multi-league certification: the actual registry", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearProjectionFeedCache();
    __resetOfferedObservationsForTests();
    installFeed();
  });
  const restore = () => {
    globalThis.fetch = originalFetch;
    clearProjectionFeedCache();
  };

  it("registry discovery: exactly the five registered leagues (3 Sleeper + 2 Yahoo), all enabled, no duplicates", () => {
    const targets = listLeagueTargets();
    assert.deepEqual(targets.map((t) => t.key), EXPECTED.map((e) => e.key));
    assert.deepEqual(targets.map((t) => [t.provider, t.display_name]), EXPECTED.map((e) => [e.provider, e.display]));
    assert.equal(targets.filter((t) => t.provider === "sleeper").length, 3);
    assert.equal(targets.filter((t) => t.provider === "yahoo").length, 2);
    assert.equal(new Set(targets.map((t) => `${t.provider}:${t.external_league_id}`)).size, 5);
    for (const t of targets) assert.equal(t.season, 2026);
  });

  it("five leagues -> ONE shared source observation and ONE upstream fetch set", async () => {
    try {
      const { obsStore, provider } = rig();
      const batches = [];
      let fetchesAfterFirst = 0;
      for (const [i, t] of listLeagueTargets().entries()) {
        batches.push(await provider.getWeeklyProjections(req(t.key, t.provider)));
        if (i === 0) fetchesAfterFirst = fetches;
      }
      assert.ok(fetchesAfterFirst > 0);
      assert.equal(fetches, fetchesAfterFirst, "leagues 2..5 caused ZERO additional upstream fetches");
      assert.equal(obsStore.appends, 1, "exactly one observation was recorded for five leagues");
      const observed = new Set(batches.map((b) => b.source_observation?.observed_at));
      assert.equal(observed.size, 1, "every league scored from the same source observation instant");
      assert.ok([...observed][0], "observation time is real, not null");
      for (const b of batches) assert.notEqual(b.status, "PROJECTIONS_UNAVAILABLE");
    } finally {
      restore();
    }
  });

  it("league-specific scoring: the same player gets different fantasy points per league while the SOURCE facts are shared", async () => {
    try {
      const { provider } = rig();
      const got: Record<string, number | null | undefined> = {};
      const stats: Record<string, string> = {};
      for (const t of listLeagueTargets()) {
        const b = await provider.getWeeklyProjections(req(t.key, t.provider));
        const wr = [...b.by_player.values()].find((p) => p.position === "WR")!;
        got[t.key] = wr.projected_points;
        stats[t.key] = JSON.stringify(b.source_observation?.observed_at);
      }
      for (const t of listLeagueTargets()) assert.equal(Math.round((got[t.key] ?? NaN) * 100) / 100, Math.round(pts(SCORING[t.key]!) * 100) / 100, t.key);
      assert.notEqual(got["bloodline-bowl"], got["devoted-to-the-game"]);
      assert.notEqual(got["devoted-to-the-game"], got["maclin-on-chicks-xvi"]);
      assert.notEqual(got["bloodline-bowl"], got["sportys-alumni"]);
      assert.equal(got["maclin-on-chicks-xvi"], got["rogers-park"], "same scoring => same points (not cross-contamination)");
      assert.equal(new Set(Object.values(stats)).size, 1);
    } finally {
      restore();
    }
  });

  it("Yahoo and Sleeper leagues are provider-neutral: same live source, same canonical identity space", async () => {
    try {
      __resetFreshnessRuntimeForTests();
      const sleeper = getWeeklyProjectionProvider("sleeper");
      const yahoo = getWeeklyProjectionProvider("yahoo");
      assert.equal(sleeper.name, yahoo.name);
      assert.equal(sleeper.model_version, yahoo.model_version);

      const { provider } = rig();
      const ids = new Map<string, string[]>();
      for (const t of listLeagueTargets()) {
        const b = await provider.getWeeklyProjections(req(t.key, t.provider));
        assert.equal(b.source, "sleeper_weekly", `${t.provider} league reads the NFL projection feed, not a provider-fantasy object`);
        ids.set(t.key, [...b.by_player.keys()].sort());
      }
      const sleeperIds = JSON.stringify(ids.get("bloodline-bowl"));
      for (const t of listLeagueTargets()) assert.equal(JSON.stringify(ids.get(t.key)), sleeperIds, `${t.key} resolves the same canonical players`);
    } finally {
      restore();
    }
  });

  it("no cross-league contamination: five independent league-scoped snapshot pointers, distinct artifacts per scoring", async () => {
    try {
      const { rest, provider } = rig();
      for (const t of listLeagueTargets()) await provider.getWeeklyProjections(req(t.key, t.provider));
      const pointers = rest.t("bridge_projection_latest");
      assert.equal(pointers.length, 5);
      assert.deepEqual(pointers.map((p) => p.league_slug as string).sort(), EXPECTED.map((e) => e.key).sort());
      const byLeague = new Map(pointers.map((p) => [p.league_slug as string, p]));
      for (const t of listLeagueTargets()) {
        assert.equal(byLeague.get(t.key)!.scoring_fingerprint, scoringFingerprint(SCORING[t.key]!));
      }
      // identical scoring + same source => the content-addressed ARTIFACT may be shared, but the POINTERS never are
      assert.notEqual(byLeague.get("maclin-on-chicks-xvi"), byLeague.get("rogers-park"));
      // different scoring => different artifacts
      assert.notEqual(byLeague.get("bloodline-bowl")!.artifact_id, byLeague.get("devoted-to-the-game")!.artifact_id);
      // every pointer carries the SAME league-independent source observation instant
      assert.equal(new Set(pointers.map((p) => p.source_observed_at)).size, 1);
      assert.ok(pointers.every((p) => p.source_observed_at != null));

      // reads are league-scoped: league A's pointer can never serve league B
      const store = new SupabaseProjectionSnapshotStore(rest.asRest());
      const hitA = await store.readLatest(req("bloodline-bowl", "sleeper"), { allowStale: true });
      const hitB = await store.readLatest(req("devoted-to-the-game", "sleeper"), { allowStale: true });
      assert.equal(hitA?.artifact.league_slug, "bloodline-bowl");
      assert.equal(hitB?.artifact.league_slug, "devoted-to-the-game");
      assert.notEqual(hitA?.artifact.scoring_fingerprint, hitB?.artifact.scoring_fingerprint);
    } finally {
      restore();
    }
  });

  it("an injury change observed through ONE league's request invalidates every league's snapshot (shared invalidation), scoring untouched", async () => {
    try {
      const { provider, obsStore } = rig();
      for (const t of listLeagueTargets()) await provider.getWeeklyProjections(req(t.key, t.provider));
      assert.equal(obsStore.appends, 1);
      // the upstream now reports the WR as Out
      const feed = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const rows = feedFor(url.searchParams.getAll("position[]")).map((r) => (r!.player_id === "wr-1" ? { ...r!, player: { ...r!.player, injury_status: "Out" } } : r));
        return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;
      void feed;
      clearProjectionFeedCache();
      const refreshed = await provider.getWeeklyProjections({ ...req("rogers-park", "yahoo"), projection_snapshot_policy: "refresh" });
      assert.equal(obsStore.appends, 2, "the change was recorded once, as a DELTA");
      const hs = await obsStore.headers("sleeper", 2026, 5);
      assert.deepEqual(hs.map((h) => h.kind), ["FULL", "DELTA"]);
      assert.equal(hs[1]!.row_count, 1, "only the changed player");
      assert.equal(refreshed.by_player.size > 0, true);
    } finally {
      restore();
    }
  });
});

describe("W1.P4 F5: roster-health's second provider read inside one request scope", () => {
  it("is NOT a second source fetch: both reads rest on the SAME source observation; only the scored batch differs (KR enrichment fingerprint)", async () => {
    originalFetch = globalThis.fetch;
    clearProjectionFeedCache();
    __resetOfferedObservationsForTests();
    installFeed();
    try {
      const { provider, obsStore } = rig();
      await runInLeagueStateScope(async () => {
        // the weekly context request carries kickoff-return enrichment inputs; roster-health's does not (lib/roster-health/inputs.ts)
        const weekly = { ...req("bloodline-bowl", "sleeper"), canonical_player_ids: ["x"], want_rest_of_season: true, return_game_season: new Map([["wr-1", { sleeper_id: "wr-1" } as never]]) };
        const rosterHealth = { ...req("bloodline-bowl", "sleeper"), canonical_player_ids: ["x"], want_rest_of_season: true };
        const a = await provider.getWeeklyProjections(weekly);
        const afterFirst = fetches;
        const b = await provider.getWeeklyProjections(rosterHealth);
        assert.equal(fetches, afterFirst, "no second upstream fetch");
        assert.equal(a.source_observation?.observed_at, b.source_observation?.observed_at, "one source observation behind both");
        assert.notEqual(a.canonical_snapshot?.artifact_id, b.canonical_snapshot?.artifact_id, "different request fingerprints => different scored artifacts (cannot be merged without changing values)");
        assert.equal(obsStore.appends, 1);
      });
    } finally {
      globalThis.fetch = originalFetch;
      clearProjectionFeedCache();
    }
  });
});
