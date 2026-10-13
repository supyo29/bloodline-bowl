/**
 * W2.P2 — the scheduled capture runner: opt-in flag, fail-safe behavior, no mutation of production inputs, honest accounting.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ROLE_SHADOW_FLAG, roleShadowCaptureEnabled, runRoleShadowCapture, type LeagueLoadFailure, type LeagueWeekInput, type RoleForecastLike, type RunDeps } from "../lib/role-shadow/capture";
import { MemoryRoleShadowStore, type RoleShadowStore, type WriteResult } from "../lib/role-shadow/store";
import { champion, leagueWeek, roleForecast, KICK, NOW, HOUR } from "./fixtures/role-shadow";

const deepFreeze = <T>(o: T): T => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o as object)) deepFreeze(v); } return o; };
const env = (o: Record<string, string | undefined>): NodeJS.ProcessEnv => o as unknown as NodeJS.ProcessEnv;
const ON = env({ [ROLE_SHADOW_FLAG]: "1" });

function deps(over: Partial<RunDeps> = {}, weeks?: Array<LeagueWeekInput | LeagueLoadFailure>, roles?: RoleForecastLike[]) {
  const calls = { weeks: 0, roles: 0 };
  const store = new MemoryRoleShadowStore(() => NOW);
  const d: RunDeps = {
    env: ON, now: () => NOW, store,
    loadLeagueWeeks: async () => { calls.weeks++; return weeks ?? [leagueWeek([champion()])]; },
    loadRoleForecasts: async () => { calls.roles++; return roles ?? [roleForecast()]; },
    ...over,
  };
  return { d, calls, store };
}

describe("opt-in: ROLE_SHADOW_CAPTURE must be exactly '1'", () => {
  it("flag parsing is strict (no truthy-string guessing for a flag that gates a persistent write path)", () => {
    assert.equal(roleShadowCaptureEnabled(env({ ROLE_SHADOW_CAPTURE: "1" })), true);
    for (const v of [undefined, "", "0", "true", "TRUE", "yes", "on", " 1", "1 ", "2", "enabled"]) assert.equal(roleShadowCaptureEnabled(env({ ROLE_SHADOW_CAPTURE: v })), false, String(v));
    assert.equal(ROLE_SHADOW_FLAG, "ROLE_SHADOW_CAPTURE");
  });

  it("DISABLED is a COMPLETE no-op: no context built, no Role forecasts loaded, no database call", async () => {
    for (const e of [env({}), env({ ROLE_SHADOW_CAPTURE: "0" }), env({ ROLE_SHADOW_CAPTURE: "true" })]) {
      const { d, calls } = deps({ env: e });
      let writes = 0;
      d.store = { kind: "spy", durable: true, record: async () => { writes++; return { status: "INSERTED", store_kind: "spy", durable: true } as WriteResult; }, list: async () => [] } as RoleShadowStore;
      const s = await runRoleShadowCapture(d);
      assert.equal(s.status, "DISABLED");
      assert.equal(s.flag.enabled, false);
      assert.deepEqual([calls.weeks, calls.roles, writes], [0, 0, 0]);
      assert.equal(s.failures, 0);
    }
  });

  it("enabled but persistence not configured: NOT_CONFIGURED, nothing built, nothing written", async () => {
    const { d, calls } = deps({ store: null });
    const s = await runRoleShadowCapture(d);
    assert.equal(s.status, "NOT_CONFIGURED");
    assert.deepEqual([calls.weeks, calls.roles], [0, 0]);
  });

  it("frozen-model or pre-registration integrity failure: INTEGRITY_FAILURE before any build or write", async () => {
    for (const over of [{ integrity: () => ({ ok: false, mismatches: ["challenger config hash drifted"] }) }, { preregOk: () => false }]) {
      const { d, calls, store } = deps(over);
      const s = await runRoleShadowCapture(d);
      assert.equal(s.status, "INTEGRITY_FAILURE");
      assert.equal(s.failures, 1);
      assert.deepEqual([calls.weeks, calls.roles, (await store.list()).length], [0, 0, 0]);
    }
  });
});

describe("enabled: honest, idempotent capture", () => {
  it("builds + stores records and reports exact accounting; re-running the identical evidence inserts nothing new", async () => {
    const { d, store } = deps();
    const a = await runRoleShadowCapture(d);
    assert.equal(a.status, "OK");
    assert.equal(a.totals.counters.built, 1);
    assert.deepEqual(a.totals.by_status, { INSERTED: 1 });
    const b = await runRoleShadowCapture(d);
    assert.deepEqual(b.totals.by_status, { DUPLICATE_IDENTICAL: 1 });
    assert.equal((await store.list()).length, 1);
  });

  it("dry run builds and counts but writes NOTHING (and needs no store)", async () => {
    const { d, store } = deps({ dryRun: true, store: null });
    const s = await runRoleShadowCapture(d);
    assert.equal(s.status, "OK");
    assert.equal(s.dry_run, true);
    assert.equal(s.totals.counters.built, 1);
    assert.deepEqual(s.totals.by_status, {});
    assert.equal((await store.list()).length, 0);
  });

  it("late candidates (kickoff already passed) are REJECTED and counted — nothing stored, nothing relabeled", async () => {
    const { d, store } = deps({ now: () => KICK + HOUR });
    const s = await runRoleShadowCapture(d);
    assert.equal(s.status, "OK");
    assert.equal(s.totals.counters.built, 0);
    assert.equal(s.totals.counters.rejected_late, 1);
    assert.equal((await store.list()).length, 0);
  });

  it("the same Role forecast week is loaded once and shared across leagues", async () => {
    const { d, calls } = deps({}, [leagueWeek([champion()]), leagueWeek([champion()], { league_slug: "devoted-to-the-game" })]);
    await runRoleShadowCapture(d);
    assert.equal(calls.roles, 1);
  });
});

describe("REGRESSION (real-source dry run): the capture clock is read AFTER the contexts are composed", () => {
  it("a context that takes real time to compose is still captured: composed_at <= captured_at holds because the clock is read after loading", async () => {
    const t = { now: NOW };
    const lw = (): LeagueWeekInput => { t.now += 90_000; /* the build takes 90 s */ return leagueWeek([champion({ composed_ms: t.now, observed_ms: t.now - 2_000 })]); };
    const store = new MemoryRoleShadowStore(() => t.now + 10_000);
    const s = await runRoleShadowCapture({ env: ON, now: () => t.now + 5_000, store, loadLeagueWeeks: async () => [lw()], loadRoleForecasts: async (_s, _w, nowMs) => [roleForecast({ as_of_ms: nowMs })] });
    assert.equal(s.totals.counters.rejected_incoherent, 0, JSON.stringify(s.totals.counters));
    assert.equal(s.totals.counters.built, 1);
    assert.equal((await store.list()).length, 1);
  });

  it("the Role forecasts are frozen at the SAME captured instant the records carry (as-of <= captured, never after)", async () => {
    const seen: number[] = [];
    const { d, store } = deps({ loadRoleForecasts: async (_s, _w, nowMs) => { seen.push(nowMs); return [roleForecast({ as_of_ms: nowMs })]; } });
    await runRoleShadowCapture(d);
    assert.deepEqual(seen, [NOW]);
    assert.equal((await store.list())[0]!.timing.captured_at, new Date(NOW).toISOString());
  });
});

describe("REGRESSION (real-source dry run): the league's rostered set is the league's, not the requesting manager's", () => {
  it("rosteredForecasts() keeps every player rostered on ANY team and drops free agents; leagueRosteredIds() unions all rosters", async () => {
    const { leagueRosteredIds, rosteredForecasts } = await import("../lib/persistence/supabase/role-shadow-runtime");
    const ids = leagueRosteredIds({ rosters: [{ all_players: ["a", "b"] }, { all_players: ["b", "c"] }, { all_players: [] }] });
    assert.deepEqual([...ids].sort(), ["a", "b", "c"]);
    const mk = (id: string) => champion({ id, sleeper_id: `s${id}`, gsis_id: `00-${id}` });
    const batch = { by_player: new Map(["a", "b", "c", "freeagent"].map((id) => [id, mk(id)])) };
    assert.deepEqual(rosteredForecasts(batch, ids).map((f) => f.canonical_player_id).sort(), ["a", "b", "c"]);
  });

  it("the production loader derives the set from the league SNAPSHOT's rosters and never from the manager-scoped `ctx.all_rostered`", async () => {
    const src = (await import("node:fs")).readFileSync("lib/persistence/supabase/role-shadow-runtime.ts", "utf8");
    assert.match(src, /leagueRosteredIds\(st\.snapshot\)/);
    assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ""), /ctx\.all_rostered/);
  });
});

describe("fail-safe: no failure here can throw into a caller or block anything", () => {
  it("a league that cannot build is reported and the remaining leagues still capture", async () => {
    const { d, store } = deps({}, [{ league_slug: "broken", failure: "no canonical snapshot / manager" }, leagueWeek([champion()])]);
    const s = await runRoleShadowCapture(d);
    assert.equal(s.status, "PARTIAL");
    assert.equal(s.failures, 1);
    assert.deepEqual(s.leagues.map((l) => [l.league_slug, l.ok]), [["broken", false], ["bloodline-bowl", true]]);
    assert.equal((await store.list()).length, 1);
  });

  it("an unavailable research database: every write is counted as ERROR, the run returns normally, nothing throws", async () => {
    const dead: RoleShadowStore = { kind: "supabase", durable: true, record: async () => { throw new Error("connect ECONNREFUSED"); }, list: async () => [] };
    const { d } = deps({ store: dead });
    const s = await runRoleShadowCapture(d);
    assert.equal(s.status, "PARTIAL");
    assert.deepEqual(s.totals.by_status, { ERROR: 1 });
    assert.equal(s.failures, 1);
  });

  it("partial failure: one record's write fails, the others are still written", async () => {
    const mem = new MemoryRoleShadowStore(() => NOW);
    let n = 0;
    const flaky: RoleShadowStore = { kind: "flaky", durable: false, list: (f) => mem.list(f), record: async (r) => { if (++n === 1) throw new Error("boom"); return mem.record(r); } };
    const two = leagueWeek([champion({ id: "pA", sleeper_id: "sA", gsis_id: "00-A" }), champion({ id: "pB", sleeper_id: "sB", gsis_id: "00-B" })]);
    const roles = [roleForecast({ gsis: "00-A", sleeper: "sA" }), roleForecast({ gsis: "00-B", sleeper: "sB", id: "rf:bbbbbbbbbbbbbbbbbbbbbbbb" })];
    const { d } = deps({ store: flaky }, [two], roles);
    const s = await runRoleShadowCapture(d);
    assert.deepEqual(s.totals.by_status, { ERROR: 1, INSERTED: 1 });
    assert.equal((await mem.list()).length, 1);
    // a retry later completes the missing one without duplicating the other
    const retry = await runRoleShadowCapture(deps({ store: flaky }, [two], roles).d);
    assert.deepEqual(retry.totals.by_status, { DUPLICATE_IDENTICAL: 1, INSERTED: 1 });
    assert.equal((await mem.list()).length, 2);
  });

  it("a Role-forecast load failure fails that league only; the summary says why", async () => {
    const { d } = deps({ loadRoleForecasts: async () => { throw new Error("role profiles unreadable"); } });
    const s = await runRoleShadowCapture(d);
    assert.equal(s.status, "PARTIAL");
    assert.match(s.leagues[0]!.code ?? "", /role profiles unreadable/);
  });

  it("the capture NEVER MUTATES the production forecasts or Role forecasts it observes (deep-frozen inputs run clean)", async () => {
    const lw = deepFreeze(leagueWeek([champion()]));
    const roles = deepFreeze([roleForecast()]);
    const before = JSON.stringify([lw, roles]);
    const { d } = deps({}, [lw], roles);
    const s = await runRoleShadowCapture(d);
    assert.equal(s.status, "OK");
    assert.equal(JSON.stringify([lw, roles]), before);
  });
});
