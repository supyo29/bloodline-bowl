/**
 * Phase 3.5B — the surface registry is verified against the repository, so it cannot drift like prose.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { INTELLIGENCE_SURFACES, type IntelligenceSurface } from "@/lib/canonical/intelligence-surface-registry";

const ROOT = process.cwd();
const has = (p: string) => existsSync(join(ROOT, p));
const json = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8")) as Record<string, unknown>;
const walk = (dir: string, ext: string[]): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((e) => {
    const rel = `${dir}/${e}`;
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel, ext) : ext.some((x) => rel.endsWith(x)) ? [rel] : [];
  });

test("registry: unique ids; every surface carries the full contract", () => {
  const ids = INTELLIGENCE_SURFACES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(INTELLIGENCE_SURFACES.length >= 14);
  for (const s of INTELLIGENCE_SURFACES) {
    for (const k of ["name", "owning_module", "nature", "deployment", "source_data", "confidence_semantics", "freshness_owner", "lineage_owner"] as const)
      assert.ok(s[k] && s[k].length > 3, `${s.id}.${k}`);
    assert.ok(s.status.length >= 1 && s.docs.length >= 1 && s.tests.length >= 1, s.id);
  }
});

test("registry: every referenced artifact, manifest, reader, doc, test and builder entrypoint exists", () => {
  for (const s of INTELLIGENCE_SURFACES) {
    for (const p of [...s.served_artifacts, ...(s.manifest ? [s.manifest] : []), ...s.readers, ...s.docs, ...s.tests, ...s.builder.entrypoints])
      assert.ok(has(p), `${s.id}: missing ${p}`);
  }
});

test("registry: the named version field exists in the manifest and looks like a version", () => {
  for (const s of INTELLIGENCE_SURFACES.filter((x) => x.manifest && x.version_field)) {
    const v = json(s.manifest!)[s.version_field!];
    assert.equal(typeof v, "string", `${s.id}: ${s.version_field}`);
    assert.match(v as string, /^[a-z]+:\d{4}:w\d{2}:[0-9a-f]{12}$|^ri-startsit-\d{4}\.\d+$/, `${s.id}: ${v}`);
  }
});

test("registry: deployment claims match the served manifests (nothing is silently more active than declared)", () => {
  const dep = (p: string, k: string) => json(p)[k];
  assert.equal(dep("lib/opportunity-propagation-intelligence/data/opportunity_propagation_manifest.json", "deployment_state"), "SHADOW_ONLY");
  assert.equal(dep("lib/player-role-intelligence/data/role_opportunity_manifest.json", "deployment_state"), "SHARED_CONTEXT");
  assert.equal(dep("lib/player-role-intelligence/data/role_opportunity_manifest.json", "eligible_to_influence_production"), false);
  assert.equal(dep("lib/player-scheme-intelligence/data/player_scheme_manifest.json", "fantasy_adjustment_enabled"), false);
  assert.equal(dep("lib/weekly/data/start_sit_model.json", "deployment"), "SHADOW_ONLY");
  assert.equal(dep("lib/weekly/data/matchup_distribution_model.json", "deployment"), "SHADOW_ONLY");
  assert.equal(dep("lib/weekly/data/matchup_correlation_model.json", "deployment"), "SHADOW_ONLY");
  for (const s of INTELLIGENCE_SURFACES.filter((x) => x.status.includes("SHADOW"))) assert.match(s.deployment, /SHADOW_ONLY/, s.id);
  for (const s of INTELLIGENCE_SURFACES.filter((x) => x.status.includes("DESCRIPTIVE_ONLY"))) assert.doesNotMatch(s.deployment, /PRODUCTION_ACTIVE/, s.id);
});

const routeExists = (tpl: string) => has(`app/api${tpl.replace(/^\/api/, "")}/route.ts`);

test("registry: every declared route exists; reachability class agrees with routes", () => {
  for (const s of INTELLIGENCE_SURFACES) {
    for (const r of s.routes) assert.ok(routeExists(r), `${s.id}: route ${r}`);
    const routed = s.routes.length > 0;
    if (routed) assert.ok(["FULLY_REACHABLE", "EMBEDDED_IN_ROUTE"].includes(s.reachability), `${s.id} has routes but is ${s.reachability}`);
    else assert.ok(["LIBRARY_ONLY_INTENTIONAL", "COMPUTED_AT_REQUEST", "INTERNAL_ARTIFACT"].includes(s.reachability), `${s.id} has no routes but is ${s.reachability}`);
    if (s.status.includes("UNREACHABLE")) assert.equal(s.routes.length, 0);
  }
});

/* ------------------------- import graph (real, not name-based) ------------------------- */
function importsOf(file: string): string[] {
  const src = readFileSync(join(ROOT, file), "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/(?:import|export)\s[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) out.push((m[1] ?? m[2])!);
  return out;
}
function resolveSpec(from: string, spec: string): string | null {
  let base: string | null = null;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = relative(ROOT, resolve(dirname(join(ROOT, from)), spec));
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}/index.ts`]) if (has(c) && statSync(join(ROOT, c)).isFile()) return c;
  return base;
}
const LIB_FILES = walk("lib", [".ts"]);
const GRAPH = new Map<string, string[]>(LIB_FILES.map((f) => [f, importsOf(f).map((s) => resolveSpec(f, s)).filter((x): x is string => !!x)]));
const inModule = (path: string, mod: string) => path === mod || path.startsWith(`${mod}/`);

test("registry: declared lib consumers equal the real import graph (both directions)", () => {
  // modules whose FILES are the surface; canonical-spine is checked by its declared readers instead
  for (const s of INTELLIGENCE_SURFACES.filter((x) => x.consumers.length > 0 || x.reachability === "LIBRARY_ONLY_INTENTIONAL" || x.id === "start-sit-fi")) {
    if (s.id === "canonical-spine") continue;
    const importers = new Set<string>();
    for (const [file, deps] of GRAPH) {
      if (inModule(file, `lib/${s.owning_module.replace(/^lib\//, "")}`)) continue;
      if (deps.some((d) => inModule(d, s.owning_module))) importers.add(file.replace(/^lib\//, ""));
    }
    const real = [...importers];
    for (const c of s.consumers) assert.ok(real.some((f) => f === c || f.startsWith(`${c}/`) || f.startsWith(c)), `${s.id}: declared consumer ${c} does not import it (real: ${real.join(", ")})`);
    const undeclared = real.filter((f) => !s.consumers.some((c) => f === c || f.startsWith(`${c}/`) || f.startsWith(c)));
    // type-only/lineage plumbing inside lib/canonical and the surface's own persistence adapter are expected; anything else must be declared
    const unexpected = undeclared.filter((f) => !f.startsWith("canonical/"));
    assert.deepEqual(unexpected, [], `${s.id}: undeclared consumers — update the registry`);
  }
});

test("registry: LIBRARY_ONLY_INTENTIONAL surfaces really have no route importing them", () => {
  const routeFiles = walk("app/api", ["route.ts"]);
  for (const s of INTELLIGENCE_SURFACES.filter((x) => x.reachability === "LIBRARY_ONLY_INTENTIONAL")) {
    for (const f of routeFiles) {
      const hit = importsOf(f).map((sp) => resolveSpec(f, sp)).filter((p): p is string => !!p).some((p) => inModule(p, s.owning_module));
      // a route is fine if ANY surface owned by the same module declares it (e.g. FI's progression sibling)
      const declaredBySibling = INTELLIGENCE_SURFACES.filter((x) => x.owning_module === s.owning_module).some((x) =>
        x.routes.some((r) => f === `app/api${r.replace(/^\/api/, "")}/route.ts`));
      if (hit) assert.ok(declaredBySibling, `${s.id}: ${f} exposes it but no surface in ${s.owning_module} declares that route`);
    }
  }
});

/* ------------------------- artifact coverage ------------------------- */
const DATA_DIRS: Array<[string, string]> = [
  ["lib/football-intel/data", "football-intelligence"],
  ["lib/player-role-intelligence/data", "role-opportunity"],
  ["lib/opportunity-propagation-intelligence/data", "opportunity-propagation"],
  ["lib/player-scheme-intelligence/data", "player-scheme"],
];
const INTERNAL_UNREFERENCED: Record<string, string> = {
  "validation_result.json": "publish-gate report written by validate_snapshot.R; no runtime reader (INTERNAL)",
};

test("registry: every served data file is accounted for (registry list, manifest tier list, or a documented INTERNAL exception)", () => {
  for (const [dir] of DATA_DIRS) {
    const manifestPath = readdirSync(join(ROOT, dir)).find((f) => f.endsWith("manifest.json"))!;
    const declared = new Set<string>();
    const collect = (o: unknown) => {
      if (typeof o === "string" && /\.csv$/.test(o)) declared.add(o);
      else if (Array.isArray(o)) o.forEach(collect);
      else if (o && typeof o === "object") Object.values(o).forEach(collect);
    };
    collect(json(`${dir}/${manifestPath}`));
    for (const s of INTELLIGENCE_SURFACES) s.served_artifacts.filter((a) => a.startsWith(dir)).forEach((a) => declared.add(a.split("/").pop()!));
    const files = readdirSync(join(ROOT, dir)).filter((f) => /\.(csv|json)$/.test(f) && !f.endsWith("manifest.json"));
    const orphans = files.filter((f) => !declared.has(f) && !INTERNAL_UNREFERENCED[f]);
    assert.deepEqual(orphans, [], `${dir}: served files no manifest/registry accounts for`);
  }
});

test("registry: weekly/data artifacts are each either read at runtime or documented INTERNAL", () => {
  const INTERNAL = new Set(["start_sit_manifest.json", "start_sit_validation.csv", "start_sit_feature_status.csv"]);
  const runtime = walk("lib", [".ts"]).map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
  for (const f of readdirSync(join(ROOT, "lib/weekly/data"))) {
    if (INTERNAL.has(f)) continue;
    assert.ok(runtime.includes(f), `lib/weekly/data/${f} has no runtime reader and is not listed INTERNAL`);
  }
});

test("registry: shape helper is exhaustive over statuses (no typo'd status slipped in)", () => {
  const ok = new Set(["ACTIVE", "SHADOW", "DESCRIPTIVE_ONLY", "RESEARCH_ONLY", "DEPRECATED", "UNREACHABLE", "STALE", "SOURCE_CONFLICT", "UNSUPPORTED"]);
  for (const s of INTELLIGENCE_SURFACES as IntelligenceSurface[]) for (const st of s.status) assert.ok(ok.has(st), `${s.id}: ${st}`);
});
