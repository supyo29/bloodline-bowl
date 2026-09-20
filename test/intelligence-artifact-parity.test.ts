/**
 * Phase 3.5B — builder / artifact / manifest / lineage parity.
 *
 * Static (non-auto-refreshed) served artifacts are hash-pinned: a targeted rebuild that rewrites an UNRELATED
 * artifact (the class of defect the FTN progression rebuild exposed) fails here and must be deliberate. Pins are
 * updated only alongside an intentional, reviewed rebuild. FI is auto-refreshed daily, so it is checked
 * structurally (manifest <-> payload <-> lineage) rather than pinned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadFootballIntelligence } from "@/lib/football-intel";
import { buildFootballIntelligenceLineage } from "@/lib/football-intel/lineage";
import { loadRoleOpportunitySnapshot } from "@/lib/player-role-intelligence/read";
import { buildRoleOpportunityIntelligenceLineage } from "@/lib/player-role-intelligence/lineage";
import { loadOpportunityPropagationModel } from "@/lib/opportunity-propagation-intelligence/read";
import { buildOpportunityPropagationIntelligenceLineage } from "@/lib/opportunity-propagation-intelligence/lineage";
import { playerSchemeContentIdentity } from "@/lib/player-scheme-intelligence/query";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const json = (p: string) => JSON.parse(read(p)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const sha = (p: string) => createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex");
function csvRows(p: string): Array<Record<string, string>> {
  const lines = read(p).split(/\r?\n/).filter(Boolean);
  const split = (l: string) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
  const head = split(lines[0]!).slice(0, -0 || undefined);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i]!, v])));
}

/** sha256 of every statically built served artifact (Role, Opportunity Propagation, Player-Scheme, weekly models). */
export const PINNED_STATIC_ARTIFACTS: Record<string, string> = {
  "lib/player-role-intelligence/data/player_game_role.csv": "a8c17687283a21a244d3968f725d76028eb6f3026ef89c61b006ab4d62d071b8",
  "lib/player-role-intelligence/data/player_role_change.csv": "1fb33a5be8c71d88d1aa82f794057b272fc293a5b1a6bbd7e49295a16da174cb",
  "lib/player-role-intelligence/data/player_role_profile.csv": "da5183be12b1b48830f5396b1159ea936f41402989f15aa87ad7f251c66b059d",
  "lib/player-role-intelligence/data/role_opportunity_manifest.json": "19514ccb175042c90d2200355e0f02b12e98adb5ec19b60986a9a002957b27f1",
  "lib/opportunity-propagation-intelligence/data/inheritance_priors_league.csv": "648e9233a34880c45ce6a7038ded7935ed0a01fc5902c438c78e4189fb1822bd",
  "lib/opportunity-propagation-intelligence/data/inheritance_priors_position.csv": "a29406b2dd7a39854bf30d8034d22cfcaf705cc32d685f7ffee1e49ab314101d",
  "lib/opportunity-propagation-intelligence/data/inheritance_priors_team.csv": "d73584e773d5ed4a390b24a991cb6aff87f1f166a4a4bfe7c41a48ae186a1237",
  "lib/opportunity-propagation-intelligence/data/opportunity_propagation_manifest.json": "78e79c45387eaa169daebe6ed143c65ccf7a6a4d2488891155e2792ecb4c9569",
  "lib/opportunity-propagation-intelligence/data/position_relationship_weights.csv": "23df52020bf4d2dbeb15f9117cd63b613d742d24d67cf84829d6a2b86a16a526",
  "lib/opportunity-propagation-intelligence/data/supported_dimensions.csv": "dfea32622011e2f57b69d77568091ccb30084e5a56eea91cc5e24c8a69d4ed44",
  "lib/player-scheme-intelligence/data/defense_archetype_vector.csv": "4d5e989ddb162e45a4f4d346c38f3689259121eec1a04b93c3708e8a2621ffe5",
  "lib/player-scheme-intelligence/data/defense_pass_vulnerability.csv": "412009f220829b6b1c527b8c22d831d08ff8edc1cc4b65d388f897a3a5d00a8d",
  "lib/player-scheme-intelligence/data/defense_rush_gap.csv": "d063b842c499112c4dd87a308d4fb0a5c8c723d6dfb2c7fb2638cea9cfc997bd",
  "lib/player-scheme-intelligence/data/defense_rush_profile.csv": "f13be1faef2261430d50a397d88a79054a1c2552b9341a317fa5022797d92bc9",
  "lib/player-scheme-intelligence/data/defense_team_profile.csv": "1ddebd344bc22e8da5400001692ba71d0070b122c187ac1873b4b42a76624c52",
  "lib/player-scheme-intelligence/data/league_baselines.csv": "edbd4159a2ca280facbe700acb65671d726fd3e120c1c44af6264d6a44494fb0",
  "lib/player-scheme-intelligence/data/offense_team_profile.csv": "8471aed62df86703723adcdf1cd9c8b1db5bd7567fa526951fcc79b43c6b55e2",
  "lib/player-scheme-intelligence/data/player_directory.csv": "b8918ac31b2a400d79676f0f75c274afb62495940efc654104de805023560133",
  "lib/player-scheme-intelligence/data/player_scheme_interactions.csv": "e6b1ac620bfb3ee1ede9f9523fd4e49cd25a3d7a599ce6e65eed6f74d08774e6",
  "lib/player-scheme-intelligence/data/player_scheme_manifest.json": "48825c3446e09c45810b1f4f4a062b56e8451c5d03d035ec6747d06a8e790cb5",
  "lib/player-scheme-intelligence/data/qb_archetype_vector.csv": "e926c8685321e4a4ae0d037e4a5e83d0803d01a473aa380abb77de812370f729",
  "lib/player-scheme-intelligence/data/qb_concept_profile.csv": "102d848350cba60b8880912d4e69c6aa4d3e00123a24e154c3fd9276f98ce7cd",
  "lib/player-scheme-intelligence/data/qb_coverage_family.csv": "52d10bbcfa888731208617b69c4cd6f94f1d6b53946e325ed4c274f7f23e0403",
  "lib/player-scheme-intelligence/data/qb_coverage_profile.csv": "2756373933e38f38d87a02b418caa33f17b84454591ebd5b460c867051dcb781",
  "lib/player-scheme-intelligence/data/qb_directional.csv": "9320200038e176d1002aa6325dd5735184ffd10aa0f7bb19fcbe8d20e73ae8b5",
  "lib/player-scheme-intelligence/data/qb_formation_profile.csv": "7e2f9a2df7d8982ec89e75ae751e3e2b5be27a38ca16f20821f1f2f3e4523b22",
  "lib/player-scheme-intelligence/data/qb_pressure_profile.csv": "56a4644f058b7fcfc977b9e59eb6b86a01d48ced5ae1e2a4c6542310ef043135",
  "lib/player-scheme-intelligence/data/qb_progression_profile.csv": "d70646f2301ea64000d5d5f3d3649f352c3a8cb3a4a4ed6843544d6a64b51b71",
  "lib/player-scheme-intelligence/data/qb_rusher_count_profile.csv": "f8fec87770c1e63eabd47a819a6ace5de7e0c4ef5c4f113ac5426f1bbf990c5b",
  "lib/player-scheme-intelligence/data/qb_spatial_matrix.csv": "5b346e285de791db19b9a5d1f701bb3c01f091cc245baf04e487b02e6c7a13da",
  "lib/player-scheme-intelligence/data/rb_box_profile.csv": "900b8c2592a6bfd0866330c606838c1aa338edfba8a8e6044f208f6c958240fe",
  "lib/player-scheme-intelligence/data/rb_rush_gap.csv": "f99288964c41536ed8c72566b5c59e47dc8e412f89bc6cf9ac1d0eab65e6497c",
  "lib/player-scheme-intelligence/data/rb_rush_matrix.csv": "35be93dc3934ad4ab6e14b750890c93f51864a78b862a6cb7bf163985100e877",
  "lib/player-scheme-intelligence/data/receiver_coverage_profile.csv": "2776454b14df08b91e737dc367c3cf1ea453297c2cce1b32b49b4c90bfebbb43",
  "lib/player-scheme-intelligence/data/receiver_route_profile.csv": "732a0c10f85b0810f2849355f7a437f7cd3139ce380967d1699a4b1ff438afff",
  "lib/player-scheme-intelligence/data/receiver_spatial_matrix.csv": "b98d51439c7bff6e37c6dc514c7414885c2f292303423ae59cd75cd525820471",
  "lib/player-scheme-intelligence/data/scheme_era.csv": "087f4309448379b4ce10a860427537457a06bfff1f1851ebe21a2bba73b7a275",
  "lib/weekly/data/start_sit_model.json": "85d2ddd501cc10d5b3a699629f80c0c3781fe12fa24fa834f41969cb0186b293",
  "lib/weekly/data/start_sit_manifest.json": "ba40538f576a71f1f3b0c256931f91551249eb20c2d41f3d25671174812e5def",
  "lib/weekly/data/start_sit_feature_status.csv": "9870cfc3fadd48223c69a0564dec93cfe8d67cac453c32c91fe044c599cd596d",
  "lib/weekly/data/start_sit_validation.csv": "9adba5a0f671240554787a498995b6d526fef969a19cf7871b1d7f3253fd3b02",
  "lib/weekly/data/matchup_correlation_model.json": "31350200017ee34fa9404f9ddf02c2f3a4efb3f955145dbda365235357022aa8",
  "lib/weekly/data/matchup_distribution_model.json": "be14e7e3bc97b8e5aad19dbdd6504c259de7205549f85d528819ef71942930e0"
};

test("pinned static artifacts are unchanged (a targeted rebuild must not rewrite unrelated artifacts)", () => {
  const changed = Object.entries(PINNED_STATIC_ARTIFACTS).filter(([p, h]) => !existsSync(join(ROOT, p)) || sha(p) !== h).map(([p]) => p);
  assert.deepEqual(changed, [], "served artifact changed — if this is an intentional rebuild, update the pin in the same commit and record why");
});

test("pins cover every file in the statically built data directories (nothing served unpinned)", () => {
  for (const dir of ["lib/player-role-intelligence/data", "lib/opportunity-propagation-intelligence/data", "lib/player-scheme-intelligence/data"]) {
    for (const f of readdirSync(join(ROOT, dir)).filter((x) => /\.(csv|json)$/.test(x))) assert.ok(`${dir}/${f}` in PINNED_STATIC_ARTIFACTS, `${dir}/${f} is not pinned`);
  }
});

test("frozen start-sit artifact pin is the certified Phase 3.5A hash", () => {
  assert.equal(PINNED_STATIC_ARTIFACTS["lib/weekly/data/start_sit_model.json"], "85d2ddd501cc10d5b3a699629f80c0c3781fe12fa24fa834f41969cb0186b293");
});

/* ------------------------------- manifest <-> version <-> payload ------------------------------- */
const versionParts = (v: string) => { const m = v.match(/^([a-z]+):(\d{4}):w(\d{2}):([0-9a-f]{12})$/); assert.ok(m, `bad version ${v}`); return { season: Number(m![2]), week: Number(m![3]) }; };

test("FI: version embeds season/through_week; every FI csv carries the manifest's season + through_week; listed files exist", () => {
  const m = json("lib/football-intel/data/football_intelligence_manifest.json");
  assert.deepEqual(versionParts(m.football_intelligence_version), { season: m.season, week: m.through_week });
  for (const f of m.files as string[]) assert.ok(existsSync(join(ROOT, "lib/football-intel/data", f)), `manifest lists missing ${f}`);
  for (const f of ["team_profile.csv", "player_usage_profile.csv", "unit_coverage_profile.csv"]) {
    const rows = csvRows(`lib/football-intel/data/${f}`);
    assert.ok(rows.length > 0);
    for (const r of rows) { if ("season" in r) assert.equal(Number(r.season), m.season, f); if ("through_week" in r) assert.equal(Number(r.through_week), m.through_week, f); }
  }
  for (const [src, wk] of Object.entries(m.data_cutoff as Record<string, number>)) assert.ok(wk <= m.through_week, `${src} cutoff ${wk} ahead of through_week`);
});

test("FI: the lineage is built from the manifest, never recomputed (version / cutoff / completion agree)", () => {
  const fi = loadFootballIntelligence({ force: true })!;
  const l = buildFootballIntelligenceLineage(fi)!;
  const m = json("lib/football-intel/data/football_intelligence_manifest.json");
  assert.equal(l.version, m.football_intelligence_version);
  assert.deepEqual(l.data_cutoff, m.data_cutoff);
  assert.equal(l.through_week, m.through_week);
  assert.deepEqual(l.week_completion, m.week_completion ?? null);
});

test("Role: version <-> season/week; row_counts match the served csvs; lineage agrees with the manifest", () => {
  const dir = "lib/player-role-intelligence/data";
  const m = json(`${dir}/role_opportunity_manifest.json`);
  assert.deepEqual(versionParts(m.role_opportunity_version), { season: m.season, week: m.through_week });
  assert.equal(csvRows(`${dir}/player_role_profile.csv`).length, m.row_counts.profiles);
  assert.equal(csvRows(`${dir}/player_role_change.csv`).length, m.row_counts.change_events);
  for (const r of csvRows(`${dir}/player_role_profile.csv`)) { assert.equal(Number(r.season), m.season); assert.equal(Number(r.through_week), m.through_week); }
  const l = buildRoleOpportunityIntelligenceLineage(loadRoleOpportunitySnapshot())!;
  assert.equal(l.version, m.role_opportunity_version); assert.deepEqual(l.data_cutoff, m.source_cutoffs); assert.equal(l.through_week, m.through_week);
  assert.equal(m.eligible_to_influence_production, false);
});

test("Opportunity Propagation: version <-> season/week; its Role dependency is exactly the served Role snapshot; lineage agrees", () => {
  const m = json("lib/opportunity-propagation-intelligence/data/opportunity_propagation_manifest.json");
  const role = json("lib/player-role-intelligence/data/role_opportunity_manifest.json");
  assert.deepEqual(versionParts(m.opportunity_propagation_version), { season: m.season, week: m.through_week });
  assert.equal(m.role_opportunity_dependency.role_opportunity_version, role.role_opportunity_version, "OPP was built against a different Role snapshot than the one served");
  assert.equal(m.role_opportunity_dependency.through_week, role.through_week);
  assert.equal(m.role_opportunity_dependency.season, role.season);
  const l = buildOpportunityPropagationIntelligenceLineage(loadOpportunityPropagationModel())!;
  assert.equal(l.version, m.opportunity_propagation_version); assert.equal(l.role_opportunity_version, role.role_opportunity_version);
  assert.equal(m.production_numeric_influence, "PROHIBITED"); assert.equal(m.eligible_to_influence_production, false);
  assert.match(m.scenario_semantics, /CONDITIONAL/); assert.match(m.scenario_semantics, /not probabilistic/i);
});

test("Player-Scheme: version <-> season/week; every tier's file list exists and the tiers cover every served csv", () => {
  const dir = "lib/player-scheme-intelligence/data";
  const m = json(`${dir}/player_scheme_manifest.json`);
  assert.deepEqual(versionParts(m.player_scheme_version), { season: m.current_season, week: m.as_of_week });
  assert.equal(m.current_season_status, "PRIOR_ONLY"); assert.equal(m.fantasy_adjustment_enabled, false);
  // auto_unbox serialises a one-element R vector as a bare string (tier_d.files) — normalise, never iterate a string
  const arr = (x: unknown): string[] => (Array.isArray(x) ? x : x ? [String(x)] : []);
  const listed = new Set<string>([...arr(m.files), ...arr(m.tier_b.files), ...arr(m.tier_c.files), ...arr(m.tier_d.files)]);
  for (const f of listed) assert.ok(existsSync(join(ROOT, dir, f)), `manifest lists missing ${f}`);
  const served = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".csv"));
  assert.deepEqual(served.filter((f) => !listed.has(f)), [], "served csv not covered by any tier's file list");
  for (const t of ["tier_b", "tier_c", "tier_d"]) assert.match(m[t].served_content_sha256, /^[0-9a-f]{64}$/, t);
});

test("Player-Scheme content identity: deterministic, tier-sensitive, and distinct from player_scheme_version (Phase 3.5B lineage repair)", () => {
  const m = json("lib/player-scheme-intelligence/data/player_scheme_manifest.json");
  const a = playerSchemeContentIdentity(m);
  assert.equal(a.served_content_id, playerSchemeContentIdentity(structuredClone(m)).served_content_id);
  assert.match(a.served_content_id, /^psc:[0-9a-f]{12}$/);
  for (const t of ["tier_b", "tier_c", "tier_d"]) {
    const x = structuredClone(m); x[t].served_content_sha256 = "f".repeat(64);
    assert.notEqual(playerSchemeContentIdentity(x).served_content_id, a.served_content_id, `a ${t} rebuild must change the served content id`);
  }
  // ...while the legacy Tier-A-only version, by construction, would NOT have moved:
  assert.equal(m.player_scheme_version.split(":")[3], a.tiers.A!.content_id);
  assert.ok(a.tiers.B!.built_at && a.tiers.C!.built_at && a.tiers.D!.built_at);
});

test("targeted Tier B/C/D rebuilds write only their own manifest keys (cannot rewrite unrelated tiers)", () => {
  for (const [t, own] of [["B", "tier_b"], ["C", "tier_c"], ["D", "tier_d"]] as const) {
    const src = read(`analysis/player_scheme_intelligence/build_tier${t}.R`);
    const keys = [...src.matchAll(/manifest\$([A-Za-z_]+)\s*<-/g)].map((x) => x[1]);
    assert.deepEqual([...new Set(keys)].sort(), ["tiers", own].sort(), `build_tier${t}.R touches manifest keys ${keys.join(",")}`);
  }
});

test("FI rebuild isolation: build_candidate.sh writes only under the candidate root", () => {
  const sh = read("analysis/football_intel/build_candidate.sh");
  assert.match(sh, /FI_ROOT="\$CANDIDATE_ROOT"/); assert.match(sh, /ln -sfn/);
});

test("Start/Sit artifacts agree with each other; the model's FI version is the TRAINING FI, not the current one", () => {
  const model = json("lib/weekly/data/start_sit_model.json"); const man = json("lib/weekly/data/start_sit_manifest.json");
  assert.equal(model.start_sit_model_version, man.start_sit_model_version);
  assert.equal(model.football_intelligence_version, man.football_intelligence_version);
  assert.equal(model.deployment, "SHADOW_ONLY");
  // documented ambiguity: this field is the FI snapshot the frozen model was fit against (prior season), never live FI lineage
  assert.match(model.football_intelligence_version, /^fi:2025:w18:/);
  assert.notEqual(model.football_intelligence_version, json("lib/football-intel/data/football_intelligence_manifest.json").football_intelligence_version);
});
