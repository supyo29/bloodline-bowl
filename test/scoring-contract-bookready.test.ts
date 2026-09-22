/** Phase 6 — Book-Ready: the league scoring contract is valid shared evidence, states support per rule, and never presents a limited rule as modeled. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoringContractEvidence } from "@/lib/book-ready/families/scoring";
import { validateEvidenceBlock } from "@/lib/book-ready/validate";
import { TOPICS } from "@/lib/book-ready/query";
import { classifyScoringKey } from "@/lib/scoring/support-contract";
import observed from "@/lib/scoring/data/observed-provider-keys.json";

const LIVE = observed.live_league_scoring as Record<string, Record<string, number>>;
const ev = (scoring: Record<string, number>, slug = "test") => scoringContractEvidence({ league_slug: slug, season: 2026, raw_scoring: scoring });
const comp = (b: ReturnType<typeof ev>[number], k: string) => b.components!.find((c) => c.key === k)!.value;
const byMetric = (bs: ReturnType<typeof ev>, m: string) => bs.find((b) => b.metric === m)!;

test("every live league's contract validates against the shared evidence contract and carries fingerprint lineage", () => {
  for (const [slug, s] of Object.entries(LIVE)) {
    const bs = ev(s, slug); assert.ok(bs.length > 5, slug);
    for (const b of bs) { assert.deepEqual(validateEvidenceBlock(b), [], `${slug} ${b.metric}`); assert.match(String(b.lineage.content_identity), /^scoring:v1:[0-9a-f]{24}$/); assert.equal(b.deployment.may_influence_production, false); assert.equal(b.predictive?.class, "DESCRIPTIVE_ONLY"); }
  }
});
test("each rule block states its support class exactly as the contract classifies it, with exact-vs-approximate and the limitation on the block", () => {
  const bs = ev(LIVE["bloodline-bowl"]!, "bloodline-bowl");
  for (const b of bs.filter((x) => x.metric.startsWith("rule."))) {
    const k = b.metric.slice(5); const r = classifyScoringKey(k); assert.equal(comp(b, "classification"), r.classification, k); assert.equal(comp(b, "exact_vs_approximate"), r.exact_vs_approximate, k);
    if (r.classification !== "FULLY_PROPAGATED") assert.ok(b.limitations.some((l) => l.startsWith(`${r.classification}:`)), `${k}: limitation must be on the block`);
  }
  assert.equal(comp(byMetric(bs, "rule.rec"), "classification"), "FULLY_PROPAGATED"); assert.equal(byMetric(bs, "rule.rec").value, 0.5);
  assert.equal(comp(byMetric(bs, "rule.kr_yd"), "classification"), "DECISION_LAYER_MISSING"); assert.equal(comp(byMetric(bs, "rule.pass_sack"), "classification"), "DECISION_LAYER_MISSING");
  assert.equal(comp(byMetric(bs, "rule.pts_allow"), "classification"), "PROVIDER_LIMITED"); assert.equal(comp(byMetric(bs, "rule.pts_allow"), "exact_vs_approximate"), "PROVIDER_STANDARD_POINTS");
});
test("K/D-ST honesty: the weekly basis block says weekly K/DEF values are NOT league-specific and lists the unreflected rules", () => {
  const b = byMetric(ev(LIVE["bloodline-bowl"]!), "contract.weekly_basis.k_dst"); assert.equal(b.value, "PROVIDER_STANDARD_POINTS_NOT_LEAGUE_SPECIFIC");
  const lim = b.limitations.join(" | "); assert.match(lim, /do NOT reflect this league's K\/D-ST scoring/); assert.match(lim, /def_forced_punts/); assert.match(lim, /pts_allow/);
  assert.equal(byMetric(ev(LIVE["bloodline-bowl"]!), "contract.weekly_basis.offense").value, "COMPONENT_RESCORED_WITH_LEAGUE_SCORING");
});
test("two leagues differing by ONE rule: different fingerprint, the rule appears only where it is scored, supported and stated", () => {
  const base = { rec: 1, rec_yd: 0.1, rec_td: 6 }; const a = ev(base), b = ev({ ...base, bonus_rec_te: 0.5 });
  assert.notEqual(a[0]!.lineage.content_identity, b[0]!.lineage.content_identity); assert.ok(!a.some((x) => x.metric === "rule.bonus_rec_te")); const r = byMetric(b, "rule.bonus_rec_te"); assert.equal(r.value, 0.5); assert.equal(comp(r, "classification"), "FULLY_PROPAGATED");
});
test("IDP, thresholds and unknown keys are never presented as modeled", () => {
  const bs = ev({ rec: 1, idp_tkl: 1, bonus_rec_yd_100: 3, some_future_key: 2 });
  assert.equal(comp(byMetric(bs, "rule.idp_tkl"), "classification"), "UNSUPPORTED"); assert.equal(comp(byMetric(bs, "rule.bonus_rec_yd_100"), "classification"), "NONLINEAR_PROJECTION_UNRESOLVED");
  assert.equal(comp(byMetric(bs, "rule.some_future_key"), "classification"), "UNSUPPORTED"); assert.match(byMetric(bs, "rule.bonus_rec_yd_100").limitations.join(" "), /projected mean|observed game/);
  for (const b of bs) assert.deepEqual(validateEvidenceBlock(b), []);
});
test("topic is registered on the shared query layer (no second registry)", () => { assert.equal(TOPICS["scoring.league_contract"]!.surface, "league-scoring-contract"); assert.deepEqual(TOPICS["scoring.league_contract"]!.required, ["league"]); });

import { CHAPTER_LIBRARY } from "@/lib/analysis-book/library";
test("Analysis Book: scoring evidence ENRICHES existing chapters only — no chapter id added/renamed, never a required need (a chapter cannot be promoted or demoted by it)", () => {
  assert.equal(Object.keys(CHAPTER_LIBRARY).length, 106, "chapter id count reflects Phase 10's lifecycle additions; still no chapter added by Phase 6 scoring"); assert.ok(!Object.keys(CHAPTER_LIBRARY).some((id) => id.startsWith("scoring.")));
  const withScoring = Object.values(CHAPTER_LIBRARY).filter((c) => c.needs.some((n) => n.topic === "scoring.league_contract")).map((c) => c.id).sort();
  assert.deepEqual(withScoring, ["decision.market_value", "decision.replacement_value", "decision.roster_fit", "trade.player_value"]);
  for (const c of Object.values(CHAPTER_LIBRARY)) for (const n of c.needs.filter((x) => x.topic === "scoring.league_contract")) assert.equal(n.role, "enrich", c.id);
});

test("K/D-ST fallback size is a MEASURED bound keyed by the canonical fingerprint: material for Bloodline Bowl, immaterial for the standard-equivalent leagues, and 'not measured' otherwise", () => {
  const lim = (sc: Record<string, number>) => byMetric(ev(sc), "contract.weekly_basis.k_dst").limitations.join(" | ");
  assert.match(lim(LIVE["bloodline-bowl"]!), /MATERIAL_DIVERGENCE/); assert.match(lim(LIVE["devoted-to-the-game"]!), /IMMATERIAL_FOR_SUPPLIED_COMPONENTS/);
  assert.match(lim({ rec: 1, fgm: 3 }), /has NOT been measured/);
});
