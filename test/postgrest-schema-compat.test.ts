/**
 * W1.R1 / P1-1: schema-compatibility detection must use the REAL error boundary.
 * Audit finding: `isMissingColumn` regex-matched message text that `SupabaseRest` never emits (it throws only
 * `Supabase <METHOD> <table> -> <status> [<code>]`), so the legacy-schema fallback was dead code and a deploy without the W1.P4 migration
 * broke durable snapshot reads/writes. The fake REST layer hid it by throwing text no real server path produces.
 * These tests drive (a) the real wrapper with real PostgREST response bodies and (b) the snapshot store/provider against a legacy schema.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { NoCrosswalk, PlayerCrosswalk } from "@/lib/canonical/players";
import { classifySchemaMismatch, SupabaseRest, SupabaseRestError } from "@/lib/persistence/supabase/rest";
import { SupabaseProjectionSnapshotStore } from "@/lib/persistence/supabase/projection-snapshot";
import { CanonicalProjectionSnapshotProvider } from "@/lib/weekly/projections/canonical-provider";
import type { KickoffSource } from "@/lib/weekly/freshness/kickoff";
import type { ProjectionProvider, ProjectionRequest } from "@/lib/weekly/projections/types";
import type { WeeklyProjectionBatch } from "@/lib/weekly/schema";
import { FakeRest } from "./fixtures/fake-rest";
import { player, proj } from "./fixtures/weekly";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Respond exactly as PostgREST does: JSON error body with `code`, `message`, `details`, `hint`. */
function postgrestFailure(status: number, body: Record<string, unknown>): void {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}
const rest = () => new SupabaseRest({ url: "https://example.supabase.co", serviceRoleKey: "SECRET-SERVICE-KEY" });

describe("W1.R1 P1-1: the real wrapper emits structured, classifiable errors", () => {
  it("42703 undefined column (select names a column that does not exist) -> MISSING_COLUMN", async () => {
    postgrestFailure(400, { code: "42703", message: 'column bridge_projection_latest.source_observed_at does not exist', details: null, hint: null });
    const e = await rest().select("bridge_projection_latest", { select: "league_slug,source_observed_at" }).catch((x) => x);
    assert.ok(e instanceof SupabaseRestError);
    assert.deepEqual([e.status, e.code, e.table, e.method], [400, "42703", "bridge_projection_latest", "GET"]);
    assert.equal(e.message, "Supabase GET bridge_projection_latest -> 400 [42703]");
    assert.equal(classifySchemaMismatch(e), "MISSING_COLUMN");
  });

  it("PGRST204 (write body names a column absent from the schema cache) -> MISSING_COLUMN", async () => {
    postgrestFailure(400, { code: "PGRST204", message: "Could not find the 'source_observed_at' column of 'bridge_projection_latest' in the schema cache", details: null, hint: null });
    const e = await rest().insertIgnoreDuplicates("bridge_projection_latest", [{ a: 1 }], ["a"]).catch((x) => x);
    assert.ok(e instanceof SupabaseRestError);
    assert.deepEqual([e.status, e.code, e.method], [400, "PGRST204", "POST"]);
    assert.equal(classifySchemaMismatch(e), "MISSING_COLUMN");
  });

  it("PGRST205 / 42P01 missing table -> MISSING_TABLE", async () => {
    postgrestFailure(404, { code: "PGRST205", message: "Could not find the table 'public.bridge_projection_source_latest' in the schema cache", details: null, hint: null });
    const a = await rest().select("bridge_projection_source_latest").catch((x) => x);
    assert.equal(classifySchemaMismatch(a), "MISSING_TABLE");
    postgrestFailure(400, { code: "42P01", message: 'relation "x" does not exist' });
    assert.equal(classifySchemaMismatch(await rest().select("x").catch((x) => x)), "MISSING_TABLE");
  });

  it("an UNRELATED 400 (bad input syntax) is not a schema mismatch", async () => {
    postgrestFailure(400, { code: "22P02", message: 'invalid input syntax for type integer: "x"' });
    assert.equal(classifySchemaMismatch(await rest().select("t").catch((x) => x)), null);
  });

  it("an UNRELATED 404 / 401 / 500 / non-JSON body is not a schema mismatch", async () => {
    postgrestFailure(404, { message: "not found" });
    assert.equal(classifySchemaMismatch(await rest().select("t").catch((x) => x)), null);
    postgrestFailure(401, { code: "PGRST301", message: "JWT expired" });
    assert.equal(classifySchemaMismatch(await rest().select("t").catch((x) => x)), null);
    postgrestFailure(500, { code: "XX000", message: "internal" });
    assert.equal(classifySchemaMismatch(await rest().select("t").catch((x) => x)), null);
    globalThis.fetch = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch;
    assert.equal(classifySchemaMismatch(await rest().select("t").catch((x) => x)), null);
  });

  it("a plain Error (even one whose text says 'schema cache') is never classified — no string parsing", () => {
    assert.equal(classifySchemaMismatch(new Error("column foo does not exist (schema cache)")), null);
    assert.equal(classifySchemaMismatch("PGRST204"), null);
    assert.equal(classifySchemaMismatch(undefined), null);
  });

  it("the service key and the server's response text never reach the error", async () => {
    postgrestFailure(400, { code: "42703", message: "SECRET-ROW-VALUE leaked?", details: "Key (x)=(SECRET-ROW-VALUE)" });
    const e = (await rest().select("t").catch((x) => x)) as Error;
    assert.doesNotMatch(e.message, /SECRET/);
  });
});

/* ---------------------------------------------------------------------------------------------- legacy-schema deployment */

const MIN = 60_000;
const KICK = Date.parse("2026-10-11T17:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const request = (): ProjectionRequest => ({
  league: { league_slug: "test-league", season: 2026, raw_scoring: { rec: 1, rec_yd: 0.1, rec_td: 6 }, scoring_rules: [] },
  week: 5,
  crosswalk: new PlayerCrosswalk(NoCrosswalk),
  canonical_player_ids: ["p1"],
  want_rest_of_season: true,
});

class Live implements ProjectionProvider {
  readonly name = "fake_live";
  readonly model_version = "v1";
  calls = 0;
  constructor(private readonly clock: { now: number }) {}
  async getWeeklyProjections(): Promise<WeeklyProjectionBatch> {
    this.calls += 1;
    return {
      league_slug: "test-league", season: 2026, week: 5, status: "READY",
      by_player: new Map([["p1", proj("p1", "WR", 10, { rest_of_season_points: 120 })]]),
      resolved_players: new Map([["p1", player("p1", "WR")]]),
      source: "fake_live", model_version: "v1", missing: [], teams_with_games: ["KC"], warnings: [],
      source_observation: { provider: "sleeper", observed_at: iso(this.clock.now), observation_id: null, content_hash: null, fetch_path: "LIVE_FETCH" },
    };
  }
}
const farKickoff: KickoffSource = { name: "fx", getWeekGames: async () => [{ game_id: "g", home_team: "KC", away_team: "LV", kickoff_at: iso(KICK), status: "pre_game" }] };

function legacyRig() {
  const clock = { now: KICK - 100 * 60 * MIN };
  const fake = new FakeRest();
  fake.missingColumns = new Set(["source_observed_at", "source_observation_id"]); // pre-W1.P4 schema
  const store = new SupabaseProjectionSnapshotStore(fake.asRest());
  const live = new Live(clock);
  const provider = new CanonicalProjectionSnapshotProvider(live, store, { now: () => clock.now, kickoffSource: farKickoff });
  return { clock, fake, store, live, provider };
}

describe("W1.R1 P1-1: W1.P4 code against the PRE-W1.P4 schema keeps the durable snapshot path working", () => {
  it("write succeeds with base pointer columns; the next request is a durable HIT (no second live read)", async () => {
    const r = legacyRig();
    const first = await r.provider.getWeeklyProjections(request());
    assert.equal(first.canonical_snapshot?.durable, true, "pointer write must not be lost");
    assert.equal(r.fake.t("bridge_projection_latest").length, 1);
    const ptr = r.fake.t("bridge_projection_latest")[0]!;
    assert.equal("source_observed_at" in ptr, false, "no W1.P4 columns were written");
    r.clock.now += 20 * MIN;
    const second = await r.provider.getWeeklyProjections(request());
    assert.equal(r.live.calls, 1, "durable reuse preserved (the audit showed every request going live)");
    assert.equal(second.canonical_snapshot?.read_path, "SUPABASE_HIT");
  });

  it("freshness degrades EXPLICITLY: source time is unknown (never the snapshot time) and the hit says why", async () => {
    const r = legacyRig();
    await r.provider.getWeeklyProjections(request());
    r.clock.now += 10 * MIN;
    // another serverless instance: no process memo, reads the durable (legacy) pointer
    const other = new CanonicalProjectionSnapshotProvider(r.live, new SupabaseProjectionSnapshotStore(r.fake.asRest()), { now: () => r.clock.now, kickoffSource: farKickoff });
    const hit = await other.getWeeklyProjections(request());
    assert.equal(hit.canonical_snapshot?.read_path, "SUPABASE_HIT");
    assert.equal(hit.canonical_snapshot?.source_observed_at ?? null, null);
    assert.ok(hit.warnings.some((w) => w.code === "projection_snapshot_source_time_unknown"));
  });

  it("legacy gating still respects the policy: an old pointer is NOT served past the tier requirement", async () => {
    const r = legacyRig();
    await r.provider.getWeeklyProjections(request());
    r.clock.now += 7 * 60 * MIN; // early week requires <= 6h
    await r.provider.getWeeklyProjections(request());
    assert.equal(r.live.calls, 2);
  });

  it("an UNRELATED 400 on the pointer read surfaces and does NOT flip the store into legacy mode", async () => {
    const clock = { now: KICK - 100 * 60 * MIN };
    const fake = new FakeRest();
    const store = new SupabaseProjectionSnapshotStore(fake.asRest());
    const live = new Live(clock);
    const provider = new CanonicalProjectionSnapshotProvider(live, store, { now: () => clock.now, kickoffSource: farKickoff });
    await provider.getWeeklyProjections(request()); // new schema: writes source columns
    assert.ok("source_observed_at" in fake.t("bridge_projection_latest")[0]!);
    const store2 = new SupabaseProjectionSnapshotStore(fake.asRest());
    fake.failures.push({ method: "GET", table: "bridge_projection_latest", status: 400, code: "22P02" });
    await assert.rejects(() => store2.readLatest(request(), { maxAgeMs: 6 * 60 * MIN, now: () => clock.now }), (e: unknown) => e instanceof SupabaseRestError && e.code === "22P02");
    const hit = await store2.readLatest(request(), { maxAgeMs: 6 * 60 * MIN, now: () => clock.now });
    assert.ok(hit?.source_observed_at, "still in full W1.P4 mode afterwards");
  });

  it("an UNRELATED 404 on the pointer write is reported as a write failure, not swallowed into legacy mode", async () => {
    const clock = { now: KICK - 100 * 60 * MIN };
    const fake = new FakeRest();
    const store = new SupabaseProjectionSnapshotStore(fake.asRest());
    const live = new Live(clock);
    const batch = await live.getWeeklyProjections();
    fake.failures.push({ method: "POST", table: "bridge_projection_latest", status: 404 });
    const w = await store.record(request(), batch, iso(clock.now));
    assert.equal(w.status, "ERROR");
    const ok = await store.record(request(), batch, iso(clock.now));
    assert.notEqual(ok.status, "ERROR");
    assert.ok("source_observed_at" in fake.t("bridge_projection_latest")[0]!, "the failed attempt did not downgrade the store");
  });

  it("applying the migration to a running deployment takes effect after the re-probe interval (no restart)", async () => {
    const r = legacyRig();
    await r.provider.getWeeklyProjections(request());
    assert.equal("source_observed_at" in r.fake.t("bridge_projection_latest")[0]!, false);
    r.fake.missingColumns.clear(); // migration applied
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * MIN; // past the re-probe interval
    try {
      const batch = await r.live.getWeeklyProjections();
      r.clock.now += 6 * MIN;
      await r.store.record(request(), batch, iso(r.clock.now));
      assert.ok("source_observed_at" in r.fake.t("bridge_projection_latest")[0]!);
    } finally {
      Date.now = realNow;
    }
  });

  it("a missing pointer TABLE is not misread as a missing column (no silent legacy mode)", async () => {
    const r = legacyRig();
    r.fake.missingColumns.clear();
    r.fake.missingTables.add("bridge_projection_latest");
    await assert.rejects(() => r.store.readLatest(request(), { maxAgeMs: MIN, now: () => r.clock.now }), (e: unknown) => classifySchemaMismatch(e) === "MISSING_TABLE");
  });
});
