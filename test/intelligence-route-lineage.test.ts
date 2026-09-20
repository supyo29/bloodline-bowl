/**
 * Phase 3.5B — route responses carry canonical lineage that agrees with the served manifest.
 * (Found: the progression route hand-assembled its own lineage instead of using the canonical builder.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadFootballIntelligence } from "@/lib/football-intel";
import { buildFootballIntelligenceLineage } from "@/lib/football-intel/lineage";

const ROOT = process.cwd();
const manifest = JSON.parse(readFileSync(join(ROOT, "lib/football-intel/data/football_intelligence_manifest.json"), "utf8"));
const pschemeManifest = JSON.parse(readFileSync(join(ROOT, "lib/player-scheme-intelligence/data/player_scheme_manifest.json"), "utf8"));

function anyReceiverGsis(): string {
  const lines = readFileSync(join(ROOT, "lib/football-intel/data/receiver_progression.csv"), "utf8").split("\n");
  const ci = lines[0]!.replace(/"/g, "").split(",").indexOf("gsis_id");
  const row = lines.slice(1).find((l) => l.trim());
  return row!.split(",")[ci]!.replace(/"/g, "");
}

test("progression route: lineage.football_intelligence IS the canonical lineage; flat fields agree with the manifest", async () => {
  const { GET } = await import("../app/api/football-intel/players/[playerId]/progression/route");
  const gsis = anyReceiverGsis();
  const res = await GET(new Request(`http://x/api/football-intel/players/${gsis}/progression`), { params: Promise.resolve({ playerId: gsis }) });
  const body = await res.json();
  const canonical = buildFootballIntelligenceLineage(loadFootballIntelligence({ force: true })!);
  assert.deepEqual(body.lineage.football_intelligence, JSON.parse(JSON.stringify(canonical)));
  assert.equal(body.lineage.football_intelligence.version, manifest.football_intelligence_version);
  assert.equal(body.lineage.football_intelligence_version, manifest.football_intelligence_version);
  assert.equal(body.lineage.snapshot_through_week, manifest.through_week);
  assert.deepEqual(body.lineage.football_intelligence.data_cutoff, manifest.data_cutoff);
  assert.equal(body.lineage.football_intelligence.generated_at, manifest.generated_at);
  assert.equal(body.lineage.output_class, "DESCRIPTIVE_ONLY");
  assert.equal(body.lineage.numeric_read_semantics_status, "UNVERIFIED_SOURCE_CONFLICT");
  assert.match(body.lineage.read_semantics, /NOT labelled first\/second\/third read/);
  for (const r of body.rows) assert.match(r.bucket, /^(RAW_[012]|CHECKDOWN|DESIGNED|SCRAMBLE_DRILL|OTHER)$/);
});

test("player-scheme routes: response meta carries the manifest version AND the all-tier served_content_id; nature preserved", async () => {
  const { GET } = await import("../app/api/player-scheme/teams/[team]/defense/route");
  const res = await GET(new Request("http://x/api/player-scheme/teams/KC/defense"), { params: Promise.resolve({ team: "KC" }) });
  const body = await res.json();
  const meta = body.profile;
  assert.equal(meta.player_scheme_version, pschemeManifest.player_scheme_version);
  assert.match(meta.content_identity.served_content_id, /^psc:[0-9a-f]{12}$/);
  assert.equal(meta.deployment, "SHARED_DESCRIPTIVE");
  assert.equal(meta.fantasy_adjustment_enabled, false);
  assert.equal(meta.current_season_status, "PRIOR_ONLY");
  assert.equal(meta.as_of_season, pschemeManifest.current_season);
  assert.deepEqual(meta.data_cutoff, pschemeManifest.data_cutoff);
});

test("start-sit evidence diagnostics: served model/deployment/gate agree with the artifacts on disk", async () => {
  const { GET } = await import("../app/api/football-intel/startsit-evidence/route");
  const body = await (await GET()).json();
  const model = JSON.parse(readFileSync(join(ROOT, "lib/weekly/data/start_sit_model.json"), "utf8"));
  const reeval = JSON.parse(readFileSync(join(ROOT, "lib/weekly/data/start_sit_reevaluation_manifest.json"), "utf8"));
  assert.equal(body.model.version, model.start_sit_model_version);
  assert.equal(body.model.deployment, "SHADOW_ONLY");
  assert.equal(body.model.any_fi_production_influence, false);
  assert.equal(body.evidence_gate.status, reeval.reevaluation_status);
  assert.deepEqual(body.evidence_gate.qualifying_weeks, reeval.completed_fi_week_list);
  assert.equal(body.evidence_gate.gate_version, reeval.evidence_gate_version);
});
