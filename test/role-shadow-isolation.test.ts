/**
 * W2.P2 — production isolation. Role Shadow is research-only: it OBSERVES approved production outputs and writes independent records.
 *   (1) STRUCTURAL: nothing in production imports it; it imports only an allowlist of pure/read-only production helpers.
 *   (2) BEHAVIORAL: with capture enabled and a capture run executed, the real weekly context and the real lineup / start-sit / matchup / waiver
 *       decisions are byte-identical to the capture-disabled run.
 *   (3) ACCESS: the only route is a CRON_SECRET-guarded, flag-gated, non-public-read cron route; the new table has no public path.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

import { buildWeeklyTeamContext } from "../lib/weekly/context";
import { lineupEndpointView } from "../lib/weekly/intelligence";
import { buildMatchup } from "../lib/weekly/matchup";
import { buildWaiverRecommendations } from "../lib/weekly/waivers";
import { PlayerCrosswalk, NoCrosswalk } from "../lib/canonical/players";
import { setPersistence, memoryPersistence } from "../lib/persistence";
import { CanonicalProjectionSnapshotProvider } from "../lib/weekly/projections/canonical-provider";
import { MemoryFinalPregameStore } from "../lib/weekly/freshness/final-pregame";
import { runRoleShadowCapture, type RoleForecastLike } from "../lib/role-shadow/capture";
import { MemoryRoleShadowStore } from "../lib/role-shadow/store";
import { allowedMethods, classifyPath, decide } from "../lib/public-api/policy";
import { goldenProjectionProvider, goldenProvider, goldenSchedule } from "./fixtures/canonical-forecast-golden";
import { roleForecast } from "./fixtures/role-shadow";

const ROOT = process.cwd();
function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const rel = `${dir}/${e}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, acc);
    else if (/\.(ts|tsx|mjs)$/.test(e)) acc.push(rel);
  }
  return acc;
}
const importsOf = (rel: string): string[] => {
  const src = readFileSync(join(ROOT, rel), "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  // bare side-effect imports (`import "x";`) have no `from` clause and execute the module just the same
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
};

describe("(0) the import scanner sees every import form (a blind scanner would make the isolation proof vacuous)", () => {
  it("static, side-effect, re-export, dynamic and require() imports are all detected", () => {
    const tmp = "test/.tmp-import-forms.ts";
    // written under test/ (not scanned by the isolation walk) and removed immediately
    require("node:fs").writeFileSync(join(ROOT, tmp), [
      'import a from "x-static";', 'import type { T } from "x-type";', 'import "x-side-effect";', 'export * from "x-reexport";',
      'export { b } from "x-named-reexport";', 'const c = await import("x-dynamic");', 'const d = require("x-require");', "",
    ].join("\n"));
    try {
      assert.deepEqual(importsOf(tmp).sort(), ["x-dynamic", "x-named-reexport", "x-reexport", "x-require", "x-side-effect", "x-static", "x-type"]);
    } finally { require("node:fs").rmSync(join(ROOT, tmp)); }
  });
});

describe("(1) structural isolation", () => {
  const SANCTIONED_CONSUMERS = new Set([
    "lib/persistence/supabase/role-shadow-store.ts", "lib/persistence/supabase/role-shadow-runtime.ts", "app/api/cron/role-shadow-capture/route.ts",
    // read-only research helper used ONLY by scripts/role-shadow-g3.ts (asserted below: no app/ or lib/ module imports it)
    "lib/persistence/supabase/role-shadow-outcomes.ts",
  ]);

  it("NOTHING under app/ or lib/ imports lib/role-shadow except the sanctioned store, runtime wiring and cron route", () => {
    const offenders: string[] = [];
    for (const f of [...walk("app"), ...walk("lib")]) {
      if (f.startsWith("lib/role-shadow/") || SANCTIONED_CONSUMERS.has(f)) continue;
      if (importsOf(f).some((s) => /role-shadow/.test(s))) offenders.push(f);
    }
    assert.deepEqual(offenders, []);
  });

  it("the sanctioned consumers are only reachable from the cron route (the store/runtime are imported by nothing else)", () => {
    const users: string[] = [];
    for (const f of [...walk("app"), ...walk("lib")]) if (importsOf(f).some((s) => /role-shadow-(store|runtime)/.test(s))) users.push(f);
    assert.deepEqual(users.sort(), ["app/api/cron/role-shadow-capture/route.ts", "lib/persistence/supabase/role-shadow-runtime.ts"]);
  });

  it("the outcomes loader is reachable from NOTHING under app/ or lib/ (it is a script-only research helper)", () => {
    const users = [...walk("app"), ...walk("lib")].filter((f) => importsOf(f).some((s) => /role-shadow-outcomes/.test(s)));
    assert.deepEqual(users, []);
  });

  it("lib/role-shadow imports ONLY an allowlist: itself, the frozen artifacts, hashing, team codes, and pure read-only injury-model / forecast-schema helpers", () => {
    const ALLOWED = [/^\.\//, /^@\/lib\/bridge\/hash$/, /^@\/lib\/canonical\/team-codes$/, /^@\/lib\/weekly\/forecast\/(schema|injury-model|injury-priors)$/, /^\.\.\/\.\.\/scripts\/w2p[12]\/.*\.json$/, /^node:/];
    const bad: Array<[string, string]> = [];
    for (const f of walk("lib/role-shadow")) for (const s of importsOf(f)) if (!ALLOWED.some((re) => re.test(s))) bad.push([f, s]);
    assert.deepEqual(bad, []);
  });

  it("the forbidden decision surfaces are provably unreachable from lib/role-shadow: lineup, start/sit, matchup, waivers, trades, scoring, providers, sleeper client, persistence stores", () => {
    const FORBIDDEN = /(lib\/(trades|waiver2|waivers|matchup2|scoring|providers|sleeper|leagues|canonical\/state|persistence)|weekly\/(lineup|start-sit|matchup|waivers|context|intelligence|ros|replacement))/;
    for (const f of walk("lib/role-shadow")) for (const s of importsOf(f)) assert.ok(!FORBIDDEN.test(s), `${f} imports ${s}`);
  });

  it("the production forecast core does not import the research layers (Role Calibration / Role Shadow) — the existing boundary still holds", () => {
    for (const f of [...walk("lib/weekly"), ...walk("lib/trades"), ...walk("lib/waiver2")]) {
      for (const s of importsOf(f)) assert.ok(!/role-shadow|role-calibration/.test(s), `${f} imports ${s}`);
    }
  });

  it("the capture module never writes to a production decision surface: no call to a store other than the injected RoleShadowStore", () => {
    const src = walk("lib/role-shadow").map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
    assert.ok(!/\.(update|delete|upsert|insert)\s*\(/.test(src.replace(/insertIgnoreDuplicates/g, "").replace(/createHash\([^)]*\)\.update\(/g, "createHash()")), "no direct database mutation outside the store implementation (hashing excluded)");
    assert.ok(!/process\.env\.[A-Z_]*(KEY|SECRET|TOKEN)/.test(src), "reads no credentials");
    assert.ok(!/fetch\(/.test(src), "performs no network I/O");
  });
});

/* ---------------------------------------------------------------------------------------- (2) behavioral parity */
const KICK = Date.parse("2026-10-11T17:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** The ONLY excluded keys are wall-clock stamps taken from the real clock at build time (they differ between ANY two builds, flag or not). */
const WALL_CLOCK_KEYS = new Set(["generated_at", "source_synced_at"]);
const norm = (v: unknown) => JSON.stringify(v, (k, x) => (x instanceof Map ? [...x.entries()] : WALL_CLOCK_KEYS.has(k) ? undefined : x));

async function buildCtx() {
  const clock = { now: KICK - 30 * MIN };
  const inner = goldenProjectionProvider();
  const live = {
    name: inner.name, model_version: inner.model_version,
    async getWeeklyProjections(req: never) {
      const b = await inner.getWeeklyProjections(req);
      clock.now += 400;
      return { ...b, status: "READY", source_observation: { provider: "sleeper", observed_at: iso(clock.now), observation_id: "srcobs:aaaaaaaaaaaaaaaaaaaa", content_hash: "h", fetch_path: "LIVE_FETCH" } };
    },
  };
  const kickoffSource = { name: "fixture", async getWeekGames() { return ["KC", "MIA", "SF", "BUF", "OPP", "LV", "NYJ", "DAL"].map((t, i) => ({ game_id: `g${i}`, home_team: t, away_team: `X${i}`, kickoff_at: iso(KICK), status: "scheduled" })); } };
  const noStore = { kind: "none", durable: false, async readLatest() { return null; }, async record() { return { status: "NOT_CONFIGURED", artifact_id: null, observed_at: null, durable: false }; } } as never;
  setPersistence(memoryPersistence());
  const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", {
    week: 5, providerOverride: goldenProvider(), scheduleProviderOverride: goldenSchedule, riSeasonProviderOverride: null, crosswalkOverride: new PlayerCrosswalk(NoCrosswalk), skipReturnGameEnrichment: true,
    projectionProviderOverride: new CanonicalProjectionSnapshotProvider(live as never, noStore, { kickoffSource, now: () => clock.now } as never),
    projectionSnapshotPolicy: "refresh", finalPregameStoreOverride: new MemoryFinalPregameStore(),
  } as never);
  if (!r.context) throw new Error(`context failed: ${r.code}`);
  return { ctx: r.context, nowMs: clock.now };
}
const decisionsOf = (ctx: Awaited<ReturnType<typeof buildCtx>>["ctx"]) => ({
  lineup: lineupEndpointView(ctx), matchup: buildMatchup(ctx), waivers: buildWaiverRecommendations(ctx),
  forecasts: [...ctx.forecasts!.by_player.values()].map((f) => [f.canonical_player_id, f.projection.expected_points, f.projection.conditional_active_points, f.contributions]),
});

describe("(2) behavioral parity: enabling capture changes no production number or decision", () => {
  it("real weekly context + lineup / start-sit / matchup / waiver decisions are byte-identical with the flag unset vs set, and before vs after a capture run", async () => {
    const saved = process.env.ROLE_SHADOW_CAPTURE;
    try {
      delete process.env.ROLE_SHADOW_CAPTURE;
      const off = await buildCtx();
      const offDecisions = norm(decisionsOf(off.ctx));
      const offCtx = norm(off.ctx);

      process.env.ROLE_SHADOW_CAPTURE = "1";
      const on = await buildCtx();
      assert.equal(norm(decisionsOf(on.ctx)), offDecisions, "flag set: same decisions");
      assert.equal(norm(on.ctx), offCtx, "flag set: same context");

      // now actually RUN the capture over this very context, then re-derive every decision from the same object
      const forecasts = [...on.ctx.forecasts!.by_player.values()];
      const skill = forecasts.filter((f) => ["QB", "RB", "WR", "TE"].includes(f.position ?? ""));
      assert.ok(skill.length >= 4, `fixture has skill players (${skill.length})`);
      const roles: RoleForecastLike[] = skill.map((f, i) => roleForecast({ gsis: f.identifiers.gsis_id ?? `00-G${i}`, sleeper: f.identifiers.sleeper_id ?? `s${i}`, team: f.team ?? "KC", position: f.position ?? "WR", kickoff_ms: KICK, as_of_ms: on.nowMs, cutoff_ms: KICK - 5 * 24 * 60 * MIN, id: `rf:${String(i).padStart(24, "0")}` }));
      const store = new MemoryRoleShadowStore(() => on.nowMs + 60_000);
      const summary = await runRoleShadowCapture({
        env: process.env, now: () => on.nowMs + 60_000, store,
        loadLeagueWeeks: async () => [{ league_slug: on.ctx.league.slug, provider: on.ctx.league.provider, season: on.ctx.league.season, week: on.ctx.league.week, raw_scoring: on.ctx.league.raw_scoring, scoring_fingerprint: on.ctx.forecasts!.identity?.scoring_fingerprint ?? null, league_snapshot_id: null, forecast_identity_id: null, forecasts }],
        loadRoleForecasts: async () => roles,
      });
      assert.equal(summary.status, "OK");
      assert.ok(summary.totals.counters.built >= 4, `non-vacuous: records were really built from the real context ${JSON.stringify(summary.totals.counters)}`);
      assert.equal((await store.list()).length, summary.totals.counters.built);
      assert.equal(norm(on.ctx), offCtx, "capture ran: the context object is untouched");
      assert.equal(norm(decisionsOf(on.ctx)), offDecisions, "capture ran: every decision re-derived from the same context is identical");
    } finally {
      if (saved === undefined) delete process.env.ROLE_SHADOW_CAPTURE; else process.env.ROLE_SHADOW_CAPTURE = saved;
    }
  });
});

describe("(3) access: no public path to the capture job or its table", () => {
  const ROUTE = "app/api/cron/role-shadow-capture/route.ts";

  it("the route is classified self-guarded (prefix rule): no public CORS, no public read, GET/POST by anonymous callers reach only its own secret check", () => {
    const entry = classifyPath("/api/cron/role-shadow-capture");
    assert.equal(entry?.access, "self-guarded");
    assert.deepEqual([...allowedMethods(entry!)], []);
    const d = decide("GET", "/api/cron/role-shadow-capture");
    assert.equal(d.kind, "pass");
    assert.equal((d as { cors: boolean }).cors, false);
  });

  it("the route authenticates with CRON_SECRET before doing any work, and never reads the query string for the secret", async () => {
    const src = readFileSync(join(ROOT, ROUTE), "utf8");
    assert.match(src, /authorizeSecret\(request, "CRON_SECRET"\)/);
    assert.ok(src.indexOf("authorizeSecret") < src.indexOf("runScheduledRoleShadowCapture("), "auth precedes work");
    const saved = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "s3cret-for-test";
    try {
      const { GET } = await import("../app/api/cron/role-shadow-capture/route");
      assert.equal((await GET(new Request("http://x/api/cron/role-shadow-capture"))).status, 401);
      assert.equal((await GET(new Request("http://x/api/cron/role-shadow-capture?secret=s3cret-for-test"))).status, 401, "query-string secret is not accepted");
      assert.equal((await GET(new Request("http://x/api/cron/role-shadow-capture", { headers: { authorization: "Bearer wrong" } }))).status, 401);
      const savedFlag = process.env.ROLE_SHADOW_CAPTURE;
      delete process.env.ROLE_SHADOW_CAPTURE;
      const ok = await GET(new Request("http://x/api/cron/role-shadow-capture", { headers: { authorization: "Bearer s3cret-for-test" } }));
      assert.equal(ok.status, 200);
      const body = await ok.json();
      assert.equal(body.status, "DISABLED", "authorized but flag off: a no-op");
      assert.equal(body.shadow_only, true);
      if (savedFlag !== undefined) process.env.ROLE_SHADOW_CAPTURE = savedFlag;
    } finally {
      if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
    }
  });

  it("the capture is NOT scheduled by this change (enabling is an explicit deployment step), and no public route reads the table", () => {
    const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8"));
    assert.ok(!(vercel.crons ?? []).some((c: { path: string }) => /role-shadow/.test(c.path)));
    for (const f of walk("app")) {
      if (f === ROUTE) continue;
      assert.ok(!/bridge_role_shadow_captures/.test(readFileSync(join(ROOT, f), "utf8")), `${relative(ROOT, join(ROOT, f))} must not read the research table`);
    }
  });
});
