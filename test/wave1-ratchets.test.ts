/**
 * W1.R1 strengthened architecture ratchets. Added BESIDE (never replacing) the W1.P1–P4 ratchets in
 * canonical-weekly-forecast-architecture.test.ts and freshness-architecture.test.ts.
 *
 * Each ratchet has (a) the real-tree scan with an explicit, SHRINK-ONLY allowlist and (b) planted-variant tests proving the scanner catches the
 * realistic equivalent forms (aliases, wrappers, quote styles, renamed locals, spreads, a route outside lib/) and — honestly — which ones it still cannot.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

import {
  byeLiteralHoisted, byeStatusPredicate, byeStatusWritten, byeZeroTernary, importsLineupModule, isByeWritten, lineupCallNames, lineupCallsWithoutForecasts,
  privateFreshnessArithmetic, spreadRewriteWithoutByeDecision, WAVE1_RATCHET_LIMITS,
} from "./helpers/wave1-ratchets";

const ROOT = join(__dirname, "..");
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, e);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e)) out.push(rel);
  }
  return out;
};
const FILES = [...walk("lib"), ...walk("app")].map((f) => f.replaceAll("\\", "/"));
const SRC = new Map(FILES.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
const where = (pred: (path: string, src: string) => boolean): string[] => FILES.filter((f) => pred(f, SRC.get(f)!)).sort();

/* ============================================================ 1. canonical lineup: user-facing surfaces cannot bypass it */

/** files allowed to import the lineup optimizer at all. Frozen at W1.R1; may only shrink. */
const LINEUP_IMPORTERS = [
  "lib/roster-health/contingency.ts", "lib/schedule-planning/evaluate.ts", "lib/trades/competitive/owner-context.ts", "lib/trades/evaluate.ts", "lib/trades/negotiation/dependency.ts",
  "lib/trades/ros.ts", "lib/waiver2/context.ts", "lib/waiver2/roster.ts", "lib/weekly/context.ts", "lib/weekly/intelligence.ts", "lib/weekly/matchup-intelligence/build.ts",
  "lib/weekly/matchup.ts", "lib/weekly/start-sit-fi/shadow.ts", "lib/weekly/waivers.ts",
];
/** the subset that deliberately calls the optimizer on the SOURCE basis (documented compatibility debt, not user-facing headline lineups). Shrink-only. */
const SOURCE_BASIS_LINEUP_CALLERS = LINEUP_IMPORTERS.filter((f) => !["lib/weekly/intelligence.ts", "lib/weekly/matchup.ts"].includes(f));

describe("W1.R1 ratchet: the headline lineup is canonical everywhere a user can request it", () => {
  it("no route/page under app/ imports the lineup optimizer (the /api/lineup bypass class)", () => {
    assert.deepEqual(where((f, s) => f.startsWith("app/") && importsLineupModule(s)), []);
  });

  it("the set of files importing the optimizer is frozen (a wrapper in a NEW file is itself a violation)", () => {
    const found = where((f, s) => !f.startsWith("lib/weekly/lineup") && importsLineupModule(s));
    assert.deepEqual(found.filter((f) => !LINEUP_IMPORTERS.includes(f)), [], "a new importer must go through lineupEndpointView/buildLineup (lib/weekly/intelligence.ts)");
    assert.ok(LINEUP_IMPORTERS.length <= 14, "allowlist may only shrink");
  });

  it("every optimizer call without `forecasts` is in the documented source-basis set; the two canonical engines always pass them", () => {
    const missing = where((f, s) => importsLineupModule(s) && lineupCallsWithoutForecasts(s) > 0);
    assert.deepEqual(missing.filter((f) => !SOURCE_BASIS_LINEUP_CALLERS.includes(f)), []);
    for (const f of ["lib/weekly/intelligence.ts", "lib/weekly/matchup.ts"]) assert.equal(lineupCallsWithoutForecasts(SRC.get(f)!), 0, `${f} must pass canonical forecasts`);
  });

  it("the lineup route and intelligence build the headline lineup through the SAME function", () => {
    assert.match(SRC.get("app/api/lineup/[league]/[manager]/week/[week]/route.ts")!, /lineupEndpointView/);
    assert.match(SRC.get("lib/weekly/intelligence.ts")!, /lineupEndpointView\(ctx\)/);
  });
});

describe("W1.R1 ratchet self-test: planted lineup-bypass variants", () => {
  const route = (body: string) => `import { runWithWeeklyContext } from "@/lib/weekly/intelligence";\n${body}`;
  it("catches: direct import+call in a route (the audited bypass)", () => {
    const s = route(`import { buildOptimalLineup } from "@/lib/weekly/lineup";\nexport const f = (ctx: any) => buildOptimalLineup({ week: 1, roster: ctx.roster, projections: ctx.projections });`);
    assert.equal(importsLineupModule(s), true);
    assert.equal(lineupCallsWithoutForecasts(s), 1);
  });
  it("catches: an `as` alias", () => {
    const s = `import { buildOptimalLineup as bol } from "@/lib/weekly/lineup";\nbol({ projections: p });`;
    assert.deepEqual(lineupCallNames(s), ["bol"]);
    assert.equal(lineupCallsWithoutForecasts(s), 1);
  });
  it("catches: a relative-path import and a wrapper helper in a new file (import-level)", () => {
    assert.equal(importsLineupModule(`import { buildOptimalLineup } from "../lineup";\nexport const myLineup = (c: any) => buildOptimalLineup({ projections: c.projections });`), true);
  });
  it("catches: multi-line call args and nested parens", () => {
    assert.equal(lineupCallsWithoutForecasts(`import { buildOptimalLineup } from "./lineup";\nbuildOptimalLineup({\n  players: new Map(a.map((p) => [p.id, p])),\n  projections: ctx.projections,\n});`), 1);
  });
  it("does NOT flag a canonical call", () => {
    assert.equal(lineupCallsWithoutForecasts(`import { buildOptimalLineup } from "./lineup";\nbuildOptimalLineup({ projections, forecasts: ctx.forecasts });`), 0);
  });
  it("cannot see (documented): a call through a computed property or a dynamic import", () => {
    assert.equal(importsLineupModule(`const m = await import("@/lib/weekly/lineup");\nm["buildOptimalLineup"]({ projections });`), false);
  });
});

/* ============================================================================================== 2. bye semantics, equivalent forms */

/** reviewed, documented exceptions. Shrink-only. */
const BYE_PREDICATE_ALLOWED = ["lib/waiver2/roster.ts"]; // Waiver 2.0 is SHADOW_ONLY (W1.P3 doc)
const BYE_ZERO_TERNARY_ALLOWED = ["lib/schedule-planning/evaluate.ts", "lib/waiver2/value.ts"]; // per-future-week utility; shadow-only Waiver 2.0
const IS_BYE_WRITE_ALLOWED = [
  "lib/schedule-planning/evaluate.ts", // is_bye: onBye — an explicit future-week bye
  "lib/team-state/build.ts", // fantasy-matchup bye (opponent null): a different concept
  "lib/weekly/waivers.ts", // ByeDropDiagnostic fields (diagnostics, not rows)
];
const SPREAD_REWRITE_REVIEWED = [
  "lib/matchup2/capture.ts", // capture serialisation (rounds numbers, no semantics change)
  "lib/weekly/context.ts", // marks a NON-bye row with no number as unavailable
  "lib/weekly/start-sit-fi/production-gate.ts", // adds an FI delta to a non-bye production row
  "lib/weekly/start-sit-fi/shadow.ts", // shadow-only candidate row
];
const outsideForecast = (f: string) => !f.startsWith("lib/weekly/forecast/");

describe("W1.R1 ratchet: bye semantics (equivalent forms, not one exact string)", () => {
  it("no independent bye STATUS predicate in any quote style / operator (outside the canonical module and the documented shadow engine)", () => {
    assert.deepEqual(where((f, s) => outsideForecast(f) && byeStatusPredicate(s)).filter((f) => !BYE_PREDICATE_ALLOWED.includes(f)), []);
  });
  it("no hoisted `\"bye\"` constant and no hand-built `projection_status: bye` outside the canonical helpers", () => {
    assert.deepEqual(where((f, s) => outsideForecast(f) && (byeLiteralHoisted(s) || byeStatusWritten(s))), []);
  });
  it("`is_bye` is never WRITTEN with a non-false value outside the canonical module and the reviewed exceptions", () => {
    assert.deepEqual(where((f, s) => outsideForecast(f) && !f.endsWith("schema.ts") && isByeWritten(s)).filter((f) => !IS_BYE_WRITE_ALLOWED.includes(f)), []);
  });
  it("no bye-zero ternary under any variable name outside the two documented per-future-week/shadow producers", () => {
    assert.deepEqual(where((f, s) => outsideForecast(f) && byeZeroTernary(s)).filter((f) => !BYE_ZERO_TERNARY_ALLOWED.includes(f)), []);
  });
  it("a row rewrite that spreads an existing row and changes its value/status must decide the bye flag (use deriveForwardRow)", () => {
    assert.deepEqual(where((f, s) => outsideForecast(f) && spreadRewriteWithoutByeDecision(s) > 0).filter((f) => !SPREAD_REWRITE_REVIEWED.includes(f)), [], "route the rewrite through deriveForwardRow (lib/weekly/forecast/bye.ts)");
  });
  it("the two forward-row rewriters (roster-health, schedule-planning) use the shared normalization helper", () => {
    for (const f of ["lib/roster-health/contingency.ts", "lib/schedule-planning/evaluate.ts"]) assert.match(SRC.get(f)!, /deriveForwardRow\(/, f);
  });
  it("allowlists only shrink", () => {
    assert.ok(BYE_PREDICATE_ALLOWED.length <= 1 && BYE_ZERO_TERNARY_ALLOWED.length <= 2 && IS_BYE_WRITE_ALLOWED.length <= 3 && SPREAD_REWRITE_REVIEWED.length <= 4);
  });
});

describe("W1.R1 ratchet self-test: planted bye variants", () => {
  const hit = (name: string, fn: (s: string) => boolean | number, src: string, expected = true) => assert.equal(Boolean(fn(src)), expected, name);
  it("predicate: double quote, single quote, backtick, reversed operands, !==, .includes, case", () => {
    hit("double", byeStatusPredicate, `if (r.projection_status === "bye") {}`);
    hit("single", byeStatusPredicate, `if (r.projection_status === 'bye') {}`);
    hit("backtick", byeStatusPredicate, "if (r.projection_status === `bye`) {}");
    hit("reversed", byeStatusPredicate, `if ("bye" === row.projection_status) {}`);
    hit("neq", byeStatusPredicate, `if (r.projection_status !== 'bye') {}`);
    hit("includes", byeStatusPredicate, `if (["bye","out"].includes(r.projection_status)) {}`);
    hit("case", byeStatusPredicate, `switch (r.projection_status) { case "bye": return 0; }`);
    hit("not a bye status (clean)", byeStatusPredicate, `if (r.projection_status === "projected") {}`, false);
  });
  it("hoisted constant and renamed local", () => {
    hit("const", byeLiteralHoisted, `const BYE = 'bye';\nif (r.projection_status === BYE) {}`);
    hit("renamed local", byeLiteralHoisted, `let marker: string = "bye";`);
    hit("clean", byeLiteralHoisted, `const x = "byebye-not-a-literal-match" + y;`, false);
  });
  it("hand-built bye row / flag writes / carried stale flag", () => {
    hit("status written", byeStatusWritten, `return { ...row, projection_status: 'bye', projected_points: 0 };`);
    hit("is_bye true", isByeWritten, `return { ...row, is_bye: true };`);
    hit("is_bye carried from source (stale flag)", isByeWritten, `by_player.set(id, { ...wp, projected_points: pts, is_bye: wp.is_bye });`);
    hit("is_bye assignment", isByeWritten, `row.is_bye = flag;`);
    hit("is_bye false is fine", isByeWritten, `return { ...row, is_bye: false };`, false);
    hit("comparison is not a write", isByeWritten, `if (row.is_bye === true) {}`, false);
  });
  it("bye-zero ternary under renamed variables", () => {
    hit("onBye", byeZeroTernary, `const v = onBye ? 0 : pts;`);
    hit("isBye", byeZeroTernary, `const v = isBye ? 0 : pts;`);
    hit("teamHasBye", byeZeroTernary, `const v = teamHasBye ? 0 : pts;`);
    hit("clean", byeZeroTernary, `const v = flag ? 0 : pts;`, false);
  });
  it("object spread preserving stale fields", () => {
    assert.equal(spreadRewriteWithoutByeDecision(`return { ...wp, projected_points: pts, floor_points: pts * 0.7 };`), 1);
    assert.equal(spreadRewriteWithoutByeDecision(`return { ...wp, projection_status: "projected" };`), 1);
    assert.equal(spreadRewriteWithoutByeDecision(`return { ...wp, projected_points: pts, is_bye: false };`), 0);
    assert.equal(spreadRewriteWithoutByeDecision(`return deriveForwardRow(wp, pts);`), 0);
    assert.equal(spreadRewriteWithoutByeDecision(`return { ...wp, note: "x" };`), 0);
  });
  it("cannot see (documented): a numeric bye code, a status read through a helper, an in-place mutation to a non-literal", () => {
    hit("numeric code", byeStatusPredicate, `if (r.status_code === 7) {}`, false);
    hit("helper read", byeStatusPredicate, `if (statusOf(r) === "b" + "ye") {}`, false);
  });
});

/* ============================================================================================== 3. one freshness authority, harder to evade */

/** freshness-adjacent files that legitimately do their OWN time arithmetic (capture lock windows, schedule/read memos, upstream cache ceilings). Shrink-only. */
const PRIVATE_ARITHMETIC_REVIEWED: Record<string, string> = {
  "lib/weekly/freshness/policy.ts": "THE authority",
  "lib/weekly/projections/canonical-provider.ts": "event horizon (which known events describe the current week) — not an age gate",
  "lib/weekly/projections/sleeper-weekly.ts": "upstream client cache CEILING; the policy can only tighten it",
  "lib/persistence/supabase/projection-snapshot.ts": "schema re-probe interval and read memo — neither is a freshness decision",
  "lib/sleeper/client.ts": "upstream HTTP cache TTLs (the layer the policy instructs)",
  "lib/persistence/supabase/waiver2-capture-runtime.ts": "capture-domain runtime window",
  "lib/market-state/build.ts": "Market State's own freshness (separate substrate; unifying it is Wave 2)",
};

describe("W1.R1 ratchet: no private freshness arithmetic beside the policy authority", () => {
  it("any file that handles freshness inputs AND does minute/hour arithmetic is on the reviewed list (any variable name, anywhere in lib/ or app/)", () => {
    const found = where((_f, s) => privateFreshnessArithmetic(s));
    assert.deepEqual(found.filter((f) => !(f in PRIVATE_ARITHMETIC_REVIEWED)), [], "new freshness arithmetic belongs in lib/weekly/freshness/policy.ts");
  });
  it("the reviewed list only shrinks and each entry still matches (no stale exemptions)", () => {
    assert.ok(Object.keys(PRIVATE_ARITHMETIC_REVIEWED).length <= 7);
    for (const f of Object.keys(PRIVATE_ARITHMETIC_REVIEWED)) assert.ok(privateFreshnessArithmetic(SRC.get(f)!), `${f}: remove from the list`);
  });
  it("self-test: neutral-name TTL logic in a route / a waiver module is caught; a clean file is not", () => {
    assert.equal(privateFreshnessArithmetic(`const limit = 45 * 60_000;\nexport const ok = (now: number, snap: any) => now - Date.parse(snap.source_observed_at) < limit;`), true);
    assert.equal(privateFreshnessArithmetic(`export const stale = (a: any) => a.age_ms > 2 * 60 * 60 * 1000;`), true);
    assert.equal(privateFreshnessArithmetic(`const STALE_AFTER = 3 * HOUR; use(x.fetched_at);`), true);
    assert.equal(privateFreshnessArithmetic(`export const unrelated = 5 * 60_000; // a debounce, mentions no freshness field`), false);
    assert.equal(privateFreshnessArithmetic(`const limit = cfg.max_age; if (age_ms > limit) {}`), false, "a TTL from config is not seen (documented limit)");
  });
});

describe("W1.R1 ratchet limits are stated, not implied", () => {
  it("documents what the ratchets cannot catch", () => {
    assert.equal(WAVE1_RATCHET_LIMITS.length, 5);
    assert.ok(WAVE1_RATCHET_LIMITS.every((l) => l.length > 40));
  });
  it("the walk really scanned the tree (guards against a vacuous pass)", () => {
    assert.ok(FILES.length > 500, `scanned ${FILES.length}`);
    assert.ok(FILES.includes("lib/weekly/intelligence.ts") && FILES.includes("app/api/lineup/[league]/[manager]/week/[week]/route.ts") && relative(".", "x") === "x");
  });
});
