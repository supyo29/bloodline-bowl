/**
 * W1.P4 architecture ratchets: ONE freshness authority. New arbitrary TTL arithmetic must not appear around projection freshness.
 * Allowlists may only SHRINK.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, e);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e)) out.push(rel);
  }
  return out;
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Projection-freshness scope: everything that serves, gates or evaluates weekly projection freshness. */
const SCOPE = [...walk("lib/weekly"), "lib/persistence/supabase/projection-snapshot.ts", "lib/persistence/supabase/projection-observations.ts", "lib/canonical/request-scope.ts", "app/api/cron/projection-snapshot/route.ts"].filter((f) => !f.startsWith("lib/weekly/freshness/policy.ts"));

/** time-window constants defined with a numeric literal in scope. Each is a NON-projection-freshness cache/lock constant, documented here. */
const ALLOWED_LITERAL_WINDOWS: Record<string, string> = {
  "lib/weekly/freshness/kickoff.ts": "schedule memo (how long a fetched NFL schedule is reused) — not a projection freshness decision",
  "lib/weekly/start-sit-fi/capture.ts": "pre-existing lineup-lock schedule cap in a separate capture domain",
  "lib/weekly/projections/sleeper-weekly.ts": "upstream client cache CEILING; the policy can only TIGHTEN it (min(), never extends)",
  "lib/persistence/supabase/projection-snapshot.ts": "process read-memo (pagination saver); every hit is still gated by the policy's source-age requirement",
  "lib/weekly/projections/canonical-provider.ts": "event horizon: which known events describe the current week — not an age gate",
};

const WINDOW_LITERAL = /\b(?:const|let)\s+\w*(?:TTL|MAX_AGE|FRESH|STALE|WINDOW|HORIZON)\w*\s*(?::[^=]+)?=\s*[\d(]/;

test("W1.P4 ratchet: only the documented non-authority files may define a literal time-window constant", () => {
  const offenders: string[] = [];
  for (const f of SCOPE) {
    if (stripComments(read(f)).split("\n").some((l) => WINDOW_LITERAL.test(l)) && !(f in ALLOWED_LITERAL_WINDOWS)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `new TTL/age constants must live in lib/weekly/freshness/policy.ts: ${offenders.join(", ")}`);
});

test("W1.P4 ratchet: the allowlist only shrinks and every entry still exists", () => {
  assert.ok(Object.keys(ALLOWED_LITERAL_WINDOWS).length <= 5);
  for (const f of Object.keys(ALLOWED_LITERAL_WINDOWS)) {
    assert.ok(stripComments(read(f)).split("\n").some((l) => WINDOW_LITERAL.test(l)), `${f} no longer defines a literal window: remove it from the allowlist`);
  }
});

test("W1.P4 ratchet: the universal 90-minute snapshot window is gone from executable code", () => {
  for (const f of [...SCOPE, "lib/canonical/read.ts"]) {
    const code = stripComments(read(f));
    assert.doesNotMatch(code, /\b90\s*\*\s*60(?:\s*\*\s*1000)?\b/, `${f}: 90*60 literal`);
    assert.doesNotMatch(code, /\b5[_]?400[_]?000\b/, `${f}: 5400000 literal`);
    assert.doesNotMatch(code, /\b90\s*\*\s*MIN\b/, `${f}: 90 * MIN outside policy`);
    assert.doesNotMatch(code, /SERVE_WINDOW|SNAPSHOT_FRESH_MS|PROJECTION_SNAPSHOT_MAX_AGE/);
  }
});

test("W1.P4 ratchet: freshness STATE is decided only by the policy authority", () => {
  const stateLiterals: string[] = [];
  for (const f of SCOPE) {
    const code = stripComments(read(f));
    // constructing a freshness state value (not comparing/typing it) is the authority's job
    if (/(?:state|freshness_state)\s*:\s*"(?:FRESH|STALE|FROZEN_PREGAME)"\s*[,}]/.test(code) && !/forecast\/schema\.ts$/.test(f)) stateLiterals.push(f);
  }
  assert.deepEqual(stateLiterals, []);
});

test("W1.P4 ratchet: consumers evaluate freshness by calling the policy, not by re-deriving ages", () => {
  assert.match(read("lib/weekly/forecast/build.ts"), /evaluateForecastFreshness/);
  assert.match(read("lib/weekly/projections/canonical-provider.ts"), /requiredMaxAgeForBatch/);
  assert.match(read("lib/persistence/supabase/projection-snapshot.ts"), /STALE_FALLBACK_MAX_AGE_MS|TIER_MAX_AGE_MS/);
  // snapshot age arithmetic is measured from the SOURCE observation, never solely from the snapshot pointer time
  const snap = read("lib/persistence/supabase/projection-snapshot.ts");
  assert.match(snap, /source_observed_at \?\? loaded\.observed_at/);
});

test("W1.P4 ratchet: no module outside the freshness authority subtracts timestamps to decide a projection age gate", () => {
  const ageGate = /(?:Date\.now\(\)|nowMs|now_ms)\s*-\s*Date\.parse\([^)]*(?:observed_at|fetched_at)[^)]*\)\s*[<>]=?\s*\d/;
  const bad = SCOPE.filter((f) => ageGate.test(stripComments(read(f))));
  assert.deepEqual(bad, [], "compare against policy output, not a literal");
});

test("W1.P4 ratchet: freshness modules are pure — the clock is always injected (no ambient Date.now in policy/events/identity/final-pregame)", () => {
  for (const f of ["policy.ts", "events.ts", "identity.ts", "final-pregame.ts"]) {
    const code = stripComments(read(`lib/weekly/freshness/${f}`));
    assert.doesNotMatch(code, /Date\.now\s*\(/, `${f} reads the wall clock`);
    assert.doesNotMatch(code, /new Date\(\s*\)/, `${f} reads the wall clock`);
  }
});

test("W1.P4: relative tree is stable (guards against the walk silently scanning nothing)", () => {
  assert.ok(SCOPE.length > 20, `scope scanned ${SCOPE.length} files`);
  assert.ok(SCOPE.map((f) => relative(".", f)).includes("lib/weekly/projections/canonical-provider.ts"));
});
