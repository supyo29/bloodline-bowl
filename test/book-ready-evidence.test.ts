/** Phase 3.5C Checkpoints B/C/E — core-family evidence: units vs served data, identity, temporal/history, comparison, conditional, query layer. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { loadFootballIntelligence } from "@/lib/football-intel/read";
import { loadRoleOpportunitySnapshot } from "@/lib/player-role-intelligence/read";
import { defaultContext, __clearCsvCache, parseCsv } from "@/lib/book-ready/common";
import { fiPlayerUsageEvidence, fiTeamMetricEvidence } from "@/lib/book-ready/families/football-intelligence";
import { roleProfileEvidence, roleChangeEvidence, ROLE_DIMENSION_PATHS } from "@/lib/book-ready/families/role";
import { opportunityScenarioEvidence } from "@/lib/book-ready/families/opportunity";
import { schemeDefenseCoverageEvidence, schemeQbFormationEvidence, schemeQbProgressionEvidence, schemeQbSpatialEvidence } from "@/lib/book-ready/families/player-scheme";
import { getEvidence, getCapabilities, TOPICS, MAX_BLOCKS } from "@/lib/book-ready/query";
import { validateEvidenceBlock } from "@/lib/book-ready/validate";
import { loadHistoryManifest, objectPath, sha256, contentId, snapshotId, historyRoot, type SnapshotEntry } from "@/lib/book-ready/snapshots";
import { unitFor, violatesRange } from "@/lib/book-ready/units";

const ROOT = process.cwd();
const ctxH = () => defaultContext({ history: true, comparisons: true });
const all = (bs: Array<{ evidence_id: string }>, f: (b: never) => string[]) => bs.flatMap((b) => f(b as never));

/* ------------------------------ every emitted block validates ------------------------------ */
test("every retrofitted core family emits contract-valid blocks on real served data", () => {
  const fi = loadFootballIntelligence()!; const role = loadRoleOpportunitySnapshot()!;
  const blocks = [
    ...fiTeamMetricEvidence({ team: "KC" }, ctxH()), ...fiTeamMetricEvidence({ team: "CHI", side: "defense" }, ctxH()),
    ...fiPlayerUsageEvidence({ gsis_id: role.profiles.find((p) => p.identity.position === "WR")!.identity.gsis_id }, ctxH()),
    ...role.profiles.filter((p) => ["QB", "RB", "WR", "TE"].includes(p.identity.position)).slice(0, 40).flatMap((p) => roleProfileEvidence({ gsis_id: p.identity.gsis_id }, ctxH())),
  ];
  assert.ok(blocks.length > 200 && fi);
  const bad = blocks.flatMap((b) => validateEvidenceBlock(b).map((e) => `${b.metric}: ${e}`));
  assert.deepEqual(bad.slice(0, 5), []);
});

/* ------------------------------ units vs the served artifacts ------------------------------ */
test("units: every served Role/FI value satisfies its metric's TRUE range (values >1 pass only where legitimate)", () => {
  const role = loadRoleOpportunitySnapshot()!; let over1 = 0, n = 0;
  for (const p of role.profiles) for (const b of roleProfileEvidence({ gsis_id: p.identity.gsis_id }, defaultContext())) {
    if (b.availability.state !== "AVAILABLE" || typeof b.value !== "number") continue;
    n++; if (b.value > 1) { over1++; assert.ok(b.unit!.may_exceed_one, `${b.metric}=${b.value} exceeds 1 where that is not legitimate`); }
    assert.equal(violatesRange(b.value, b.unit!), false, `${b.metric}=${b.value}`);
  }
  assert.ok(n > 1000 && over1 > 0, `checked ${n}, over-1 legit cases ${over1} (QB snap share)`);
  // FI usage strict fractions really are within [0,1]
  const fi = loadFootballIntelligence()!; const gs = new Set(parseCsv(readFileSync(join(ROOT, "lib/football-intel/data/player_usage_profile.csv"), "utf8")).map((r) => r.gsis_id!));
  let m = 0; for (const g of [...gs].slice(0, 300)) for (const b of fiPlayerUsageEvidence({ gsis_id: g }, defaultContext())) { if (typeof b.value === "number") { m++; assert.equal(violatesRange(b.value, b.unit!), false, `${b.metric}=${b.value}`); } }
  assert.ok(m > 500 && fi);
});
test("units: counts stay counts, percentages stay percentages (never silently rescaled)", () => {
  const role = loadRoleOpportunitySnapshot()!; const p = role.profiles.find((x) => x.identity.position === "WR")!;
  const b = roleProfileEvidence({ gsis_id: p.identity.gsis_id }, defaultContext()).find((x) => x.metric === "receiving.target_share")!;
  const opp = b.components!.find((c) => c.key === "opportunity_total")!; assert.equal(opp.unit!.kind, "count"); assert.equal(opp.value, p.receiving!.target_share.opportunity_total);
  const proe = fiTeamMetricEvidence({ team: "KC", metrics: ["off_proe"] }, defaultContext())[0]!;
  assert.equal(proe.components!.find((c) => c.key === "raw")!.unit!.kind, "percentage");
  assert.equal(proe.components!.find((c) => c.key === "raw")!.value, loadFootballIntelligence()!.team("KC")!.offense.off_proe!.raw, "raw is passed through unmodified");
});

/* ------------------------------ values agree with the authoritative artifacts ------------------------------ */
test("evidence values equal the authoritative reader values (no transformation)", () => {
  const fi = loadFootballIntelligence()!; const r = fi.team("KC")!.offense.off_pass_epa!;
  const b = fiTeamMetricEvidence({ team: "KC", metrics: ["off_pass_epa"] }, ctxH())[0]!;
  assert.equal(b.value, r.modeled); assert.equal(b.comparison![0]!.percentile!.value, r.league_percentile); assert.equal(b.model_confidence!.source_value, r.confidence);
  assert.equal(b.origin.source_class, r.output_class); assert.equal(b.predictive!.source_status, r.predictive_status);
  const role = loadRoleOpportunitySnapshot()!; const p = role.profiles.find((x) => x.identity.position === "WR" && x.receiving!.target_share.latest !== null)!;
  const rb = roleProfileEvidence({ gsis_id: p.identity.gsis_id }, defaultContext()).find((x) => x.metric === "receiving.target_share")!;
  assert.equal(rb.value, p.receiving!.target_share.latest); assert.equal(rb.model_confidence!.source_value, p.receiving!.target_share.confidence);
});

/* ------------------------------ independent axes ------------------------------ */
test("axes are independent: HIGH-style confidence + current data + DESCRIPTIVE_ONLY family that cannot influence production", () => {
  const rows = loadFootballIntelligence()!.teams().flatMap((t) => [...Object.values(t.offense), ...Object.values(t.defense)]);
  const desc = rows.find((x) => x.predictive_status === "DESCRIPTIVE_TENDENCY" && x.modeled !== null)!;
  const b = fiTeamMetricEvidence({ team: desc.team, side: desc.side, metrics: [desc.metric] }, defaultContext())[0]!;
  assert.equal(b.predictive!.class, "DESCRIPTIVE_ONLY"); assert.equal(b.deployment.may_influence_production, false);
  assert.ok(b.model_confidence && b.freshness.through_week !== null && b.sample_support);
  assert.notEqual(b.model_confidence!.source, b.sample_support!.basis);
  assert.ok(!Object.values(b.predictive!).some((v) => String(v).endsWith("_PREDICTIVE")));
});

/* ------------------------------ identity ------------------------------ */
test("identity: placeholder / blank Player-Scheme identities stay queryable with explicit limitations; nothing is invented", () => {
  const dir = parseCsv(readFileSync(join(ROOT, "lib/player-scheme-intelligence/data/player_directory.csv"), "utf8"));
  const placeholders = dir.filter((r) => r.position === "XX" || r.position === "");
  const qbLike = ["qb_spatial_matrix.csv", "receiver_spatial_matrix.csv", "rb_rush_matrix.csv", "receiver_route_profile.csv"];
  let seen = 0;
  for (const r of placeholders) {
    const rows = qbLike.flatMap((f) => parseCsv(readFileSync(join(ROOT, "lib/player-scheme-intelligence/data", f), "utf8")).filter((x) => x.gsis_id === r.gsis_id));
    if (!rows.length) continue; seen++;
    // the identity classifier keeps the row and states the limitation
    const blocks = schemeQbSpatialEvidence({ gsis_id: r.gsis_id }, defaultContext());
    for (const b of blocks) if (b.subject.identity) { assert.equal(b.subject.identity.resolution, "PLACEHOLDER"); assert.ok(b.subject.identity.limitations.length); assert.equal(b.subject.identity.position, r.position === "" ? null : r.position); assert.equal(b.subject.identity.source_player_id, r.gsis_id); }
  }
  assert.ok(placeholders.length >= 4 && seen >= 1, "the documented XX/blank placeholders exist and carry data");
});

/* ------------------------------ source conflict / categories ------------------------------ */
test("FTN numeric read codes are SOURCE_CONFLICT and stay RAW_*; named buckets are verified; formation categories keep their raw text", () => {
  const q = parseCsv(readFileSync(join(ROOT, "lib/player-scheme-intelligence/data/qb_progression_profile.csv"), "utf8")).find((r) => r.bucket === "RAW_1")!;
  const bl = schemeQbProgressionEvidence({ gsis_id: q.gsis_id! }, defaultContext());
  const raw = bl.filter((b) => b.category!.raw.startsWith("RAW_")); const named = bl.filter((b) => !b.category!.raw.startsWith("RAW_"));
  assert.ok(raw.length && named.length);
  for (const b of raw) { assert.equal(b.origin.analysis_class, "SOURCE_CONFLICT"); assert.equal(b.origin.source_class, "UNVERIFIED_SOURCE_CONFLICT"); assert.equal(b.category!.normalized, null); assert.equal(b.category!.mapping_status, "SOURCE_CONFLICT"); assert.match(b.limitations.join(), /NOT first\/second\/third read/); }
  for (const b of named) assert.equal(b.category!.mapping_status, "VERIFIED");
  assert.ok(![...bl].some((b) => /FIRST_READ|SECOND_READ|THIRD/.test(JSON.stringify(b))));
  const uc = parseCsv(readFileSync(join(ROOT, "lib/player-scheme-intelligence/data/qb_formation_profile.csv"), "utf8")).find((r) => r.bucket === "UNDER CENTER")!;
  const f = schemeQbFormationEvidence({ gsis_id: uc.gsis_id!, window: uc.window }, defaultContext()).find((b) => b.category?.raw === "UNDER CENTER")!;
  assert.deepEqual(f.category, { raw: "UNDER CENTER", normalized: null, mapping_status: "NO_VERIFIED_MAPPING" });
});
test("Player-Scheme evidence carries all-tier content identity, canonical FI lineage and its PRIOR_ONLY limitation", () => {
  const b = schemeDefenseCoverageEvidence({ team: "KC" }, defaultContext())[0]!;
  assert.match(b.lineage.content_identity!, /^psc:[0-9a-f]{12}$/); assert.ok((b.lineage.canonical as Record<string, unknown>).football_intelligence);
  assert.match(b.limitations.join(), /PRIOR_ONLY/); assert.equal(b.deployment.may_influence_production, false);
  assert.equal(b.history!.class, "CURRENT_ONLY"); assert.deepEqual(b.history!.points, []);
});

/* ------------------------------ comparison honesty ------------------------------ */
test("comparisons always state their population; team-relative and league populations differ; incompatible scale not compared", () => {
  const role = loadRoleOpportunitySnapshot()!; const p = role.profiles.find((x) => x.identity.position === "WR" && x.receiving!.target_share.latest !== null)!;
  const b = roleProfileEvidence({ gsis_id: p.identity.gsis_id }, ctxH()).find((x) => x.metric === "receiving.target_share")!;
  const ids = b.comparison!.map((c) => c.population.id); assert.deepEqual(ids, [`NFL_WR`, `${p.identity.team}_WR`]);
  for (const c of b.comparison!) { assert.ok(c.population.n >= 2 && c.population.season === 2026 && c.rank!.position <= c.rank!.of && c.percentile!.value >= 0 && c.percentile!.value <= 1); }
  const t = fiTeamMetricEvidence({ team: "KC", metrics: ["def_pass_epa_allowed"] }, ctxH())[0]!;
  assert.equal(t.comparison![0]!.population.id, "NFL_DEFENSE_TEAMS"); assert.equal(t.comparison![0]!.percentile!.orientation, "INVERTED_VALUE");
  // without the opt-in there is no comparison at all
  assert.equal(fiTeamMetricEvidence({ team: "KC", metrics: ["off_pass_epa"] }, defaultContext())[0]!.comparison, undefined);
});

/* ------------------------------ conditional evidence ------------------------------ */
test("Opportunity Propagation stays CONDITIONAL: declared condition, consumer-supplied source, no unconditional-projection reading, no history", () => {
  const role = loadRoleOpportunitySnapshot()!; const wr = role.profiles.filter((p) => p.identity.position === "WR" && (p.receiving!.target_share.latest ?? 0) > 0.2)[0]!;
  const blocks = opportunityScenarioEvidence({ team: wr.identity.team, season: 2026, week: 2, unavailable_player_ids: [wr.identity.gsis_id] }, defaultContext());
  assert.ok(blocks.length > 10);
  for (const b of blocks) {
    assert.equal(b.origin.analysis_class, "CONDITIONAL"); assert.equal(b.temporal.point_kind, "SCENARIO"); assert.equal(b.temporal.as_of_kind, "SCENARIO_INPUT");
    assert.ok(b.relationships!.some((r) => r.type === "CONDITIONAL_ON")); assert.ok(b.relationships!.some((r) => r.type === "DEPENDS_ON"));
    assert.match(b.limitations.join(" "), /CONSUMER_SUPPLIED|consumer-supplied/); assert.match(b.limitations.join(" "), /does not estimate the probability/);
    assert.equal(b.deployment.may_influence_production, false); assert.deepEqual(validateEvidenceBlock(b), []);
    assert.ok(b.lineage.depends_on!.some((d) => d.surface === "role-opportunity"));
  }
  const ben = blocks.find((b) => b.metric.endsWith("expected_scenario_role"))!;
  assert.ok(ben.components!.some((c) => c.key === "observed_pre_scenario_role" && c.analysis_class === "OBSERVED"), "Phase 2 observed role kept separate from the conditional value");
  assert.ok(ben.components!.some((c) => c.key === "normalized_weight"), "trace decomposition exposed");
  assert.equal(ben.history!.class, "UNSUPPORTED");
  const unsupported = opportunityScenarioEvidence({ team: "KC", season: 2026, week: 2, unavailable_player_ids: ["00-0000000"] }, defaultContext());
  assert.equal(unsupported[0]!.availability.state, "UNAVAILABLE");
});

/* ------------------------------ temporal / history ------------------------------ */
test("history: points are published states with snapshot ids; the current partial week is CURRENT_UNSNAPSHOTTED, never a PUBLISHED_STATE", () => {
  const b = fiTeamMetricEvidence({ team: "KC", metrics: ["off_pass_epa"] }, ctxH())[0]!;
  const pts = b.history!.points;
  assert.ok(pts.length >= 2);
  for (const p of pts) {
    if (p.temporal.point_kind === "POINT_IN_TIME_STATE") { assert.ok(p.temporal.snapshot_id); assert.equal(p.temporal.as_of_kind, "PUBLISHED_STATE"); assert.equal(p.temporal.week_state, "COMPLETE"); }
    else { assert.equal(p.temporal.point_kind, "CURRENT_UNSNAPSHOTTED"); assert.equal(p.temporal.as_of_kind, "CURRENT_SNAPSHOT"); assert.equal(p.temporal.snapshot_id, null); }
    assert.equal(p.temporal.player_team_temporal_identity, "NOT_MODELED_UNTIL_INTELLIGENCE_MODERNIZATION_PHASE_7");
  }
  const last = pts[pts.length - 1]!; assert.equal(last.value, b.value, "the series' last point reproduces the current value");
  assert.match(b.history!.note!, /CURRENT_UNSNAPSHOTTED/);
});

/** Build a temp root holding the real store PLUS a synthetic later snapshot with different content. */
function rootWithSyntheticWeek(): { root: string; expected: number } {
  const root = mkdtempSync(join(tmpdir(), "brroot-")); cpSync(join(ROOT, "data", "intelligence-history"), join(root, "data", "intelligence-history"), { recursive: true });
  const m = loadHistoryManifest(root); const base = [...m.entries].filter((e) => e.surface === "football-intelligence").pop()!;
  const readObj = (sha: string) => gunzipSync(readFileSync(objectPath(sha, root)));
  const tp = base.files.find((f) => f.name === "team_profile.csv")!; const rows = parseCsv(readObj(tp.sha256).toString("utf8"));
  const target = rows.find((r) => r.team === "KC" && r.metric === "off_pass_epa")!; const expected = 0.4242;
  const text = readObj(tp.sha256).toString("utf8").replace(new RegExp(`("${target.modeled}")|(${target.modeled})`), String(expected));
  const buf = Buffer.from(text); const sha = sha256(buf); mkdirSync(dirname(objectPath(sha, root)), { recursive: true }); writeFileSync(objectPath(sha, root), gzipSync(buf));
  const files = base.files.map((f) => (f.name === "team_profile.csv" ? { ...f, sha256: sha, bytes: buf.length } : f)); const cid = contentId(files);
  const entry: SnapshotEntry = { ...base, version: "fi:2026:w02:synthetic00", through_week: 2, generated_at: "2026-09-22T12:00:00.000Z", content_id: cid, snapshot_id: snapshotId("football-intelligence", "fi:2026:w02:synthetic00", cid), files };
  m.entries.push(entry); writeFileSync(join(historyRoot(root), "manifest.json"), JSON.stringify(m)); return { root, expected };
}
test("history reads EACH snapshot's own content (never the latest file for every week) and keeps points in time order", () => {
  const { root, expected } = rootWithSyntheticWeek(); __clearCsvCache();
  const b = fiTeamMetricEvidence({ team: "KC", metrics: ["off_pass_epa"] }, defaultContext({ root, history: true }))[0]!;
  const states = b.history!.points.filter((p) => p.temporal.point_kind === "POINT_IN_TIME_STATE");
  assert.deepEqual(states.map((p) => p.temporal.through_week), [1, 2]);
  assert.equal(states[1]!.value, expected); assert.notEqual(states[0]!.value, expected, "week 1 is NOT overwritten by week 2's content");
  assert.ok(states[0]!.temporal.snapshot_id !== states[1]!.temporal.snapshot_id);
  assert.equal(b.change![0]!.prior_value, expected, "change is computed against the previous PRESERVED state");
  __clearCsvCache();
});

/* ------------------------------ query layer ------------------------------ */
test("query layer: unknown topic / missing params are explicit; every artifact topic returns valid blocks; capabilities map is complete", async () => {
  assert.equal((await getEvidence({ topic: "nope" })).status, "UNKNOWN_TOPIC");
  const missing = await getEvidence({ topic: "fi.team_metric", params: {} }); assert.equal(missing.status, "INVALID_REQUEST"); assert.match(missing.detail!, /team/);
  assert.equal((await getEvidence({ topic: "role.player_profile", params: {} })).status, "INVALID_REQUEST");
  const role = loadRoleOpportunitySnapshot()!; const wr = role.profiles.find((p) => p.identity.position === "WR")!.identity.gsis_id;
  const q = parseCsv(readFileSync(join(ROOT, "lib/player-scheme-intelligence/data/qb_progression_profile.csv"), "utf8"))[0]!.gsis_id!;
  for (const [topic, params] of [["fi.team_metric", { team: "KC" }], ["fi.player_usage", { gsis_id: wr }], ["role.player_profile", { gsis_id: wr }], ["role.role_change", { gsis_id: wr }], ["scheme.qb_progression", { gsis_id: q }], ["scheme.qb_spatial", { gsis_id: q }], ["scheme.defense_coverage", { team: "KC" }], ["trade.evaluation", { league: "bloodline-bowl", manager: "supyo29" }]] as const) {
    const r = await getEvidence({ topic, params }); assert.equal(r.status, "OK", topic); assert.equal(r.validation.ok, true, topic); assert.ok(r.blocks.length > 0, topic);
    assert.equal(r.performance.cost_class, "ARTIFACT_READ"); assert.ok(r.performance.approx_bytes > 0);
  }
  const caps = getCapabilities() as { topics: Record<string, unknown>; surfaces: Array<{ id: string; book_ready: { query_topics: string[] } | null }>; refresh_status: Array<{ state: string }> };
  assert.deepEqual(Object.keys(caps.topics).sort(), Object.keys(TOPICS).sort());
  assert.ok(caps.surfaces.every((s) => s.book_ready), "every registered surface declares its Book-Ready capability");
  assert.ok(caps.refresh_status.length === 3);
  assert.ok(MAX_BLOCKS >= 100);
});
test("query layer: history/comparisons are strictly opt-in and the response reports its cost class", async () => {
  const off = await getEvidence({ topic: "fi.team_metric", params: { team: "KC", metrics: "off_pass_epa" } });
  const on = await getEvidence({ topic: "fi.team_metric", params: { team: "KC", metrics: "off_pass_epa" }, history: true, comparisons: true });
  assert.equal(off.blocks[0]!.history, undefined); assert.equal(off.blocks[0]!.comparison, undefined);
  assert.ok(on.blocks[0]!.history && on.blocks[0]!.comparison);
  assert.ok(on.performance.approx_bytes > off.performance.approx_bytes);
});

test("refresh lag is a FRESHNESS fact, separate from availability: Role/OPP report lag against the completed-week frontier", () => {
  const role = loadRoleOpportunitySnapshot()!; const wr = role.profiles.find((p) => p.identity.position === "WR")!;
  const b = roleProfileEvidence({ gsis_id: wr.identity.gsis_id }, defaultContext())[0]!;
  assert.ok(b.freshness.refresh_lag_weeks === 0 || b.freshness.refresh_lag_weeks === null || b.freshness.refresh_lag_weeks! > 0);
  assert.equal(typeof b.freshness.through_week, "number"); assert.equal(roleChangeEvidence({ gsis_id: wr.identity.gsis_id }).every((x) => x.freshness.refresh_lag_weeks !== undefined), true);
  assert.ok(ROLE_DIMENSION_PATHS.length >= 11);
  void unitFor; void all;
});

test("mixed vintage: when FI's completed-week frontier is ahead, Role/OPP blocks state NOT_YET_REFRESHED and keep their own version/through_week", () => {
  const root = mkdtempSync(join(tmpdir(), "mv-")); cpSync(join(ROOT, "lib"), join(root, "lib"), { recursive: true }); cpSync(join(ROOT, "docs"), join(root, "docs"), { recursive: true });
  const mp = join(root, "lib/football-intel/data/football_intelligence_manifest.json"); const m = JSON.parse(readFileSync(mp, "utf8"));
  m.week_completion = { ...m.week_completion, latest_week: 2, week_state: "COMPLETE" }; writeFileSync(mp, JSON.stringify(m));
  const role = loadRoleOpportunitySnapshot()!; const wr = role.profiles.find((p) => p.identity.position === "WR")!;
  const cwd = process.cwd(); process.chdir(root);
  try {
    const b = roleProfileEvidence({ gsis_id: wr.identity.gsis_id }, defaultContext())[0]!;
    assert.equal(b.freshness.refresh_lag_weeks, 1); assert.equal(b.freshness.through_week, 1); assert.match(b.lineage.surface_version!, /^roi:2026:w01:/);
    assert.match(b.limitations.join(), /NOT_YET_REFRESHED.*must not be combined/); assert.deepEqual(validateEvidenceBlock(b), []);
    const caps = getCapabilities(root) as { refresh_status: Array<{ surface: string; state: string }> };
    assert.equal(caps.refresh_status.find((s) => s.surface === "role-opportunity")!.state, "NOT_YET_REFRESHED");
    assert.equal(caps.refresh_status.find((s) => s.surface === "football-intelligence")!.state, "CURRENT");
  } finally { process.chdir(cwd); }
});
