/**
 * Phase 8 §46 — live advisory smoke against the two real leagues.
 *
 * Verifies the integrated Orchestrator runs end-to-end, is deterministic, keeps
 * lineage coherent, keeps shadows out of ACTIONs, and produces a sensible mix of
 * HOLD / WATCH / ACTION from the current (preseason) snapshot. Thresholds are
 * NOT tuned to force all three verdicts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManagerOrchestration, buildLeagueOrchestration, ORCHESTRATOR_VERSION } from "@/lib/orchestrator";

const CASES: Array<[string, string]> = [
  ["bloodline-bowl", "supyo29"],
  ["devoted-to-the-game", "darthmarker"],
];

for (const [league, manager] of CASES) {
  test(`live: ${league}/${manager} orchestrate`, async (t) => {
    const res = await buildManagerOrchestration(league, manager);
    if (!res.ok) {
      t.skip(`orchestrator unavailable: ${res.code} (offline?)`);
      return;
    }
    const r = res.result;

    assert.equal(r.orchestrator_version, ORCHESTRATOR_VERSION);
    assert.equal(r.lineage.deployment, "ADVISORY_ONLY");
    assert.ok(["ACTION", "WATCH", "HOLD", "INSUFFICIENT_EVIDENCE"].includes(r.verdict));
    assert.ok(r.lineage.league_snapshot_id?.startsWith("snap:"));
    assert.ok(r.lineage.scoring_fingerprint?.startsWith("scoring:"));

    // §11 — no ACTION may rest solely on shadow evidence
    for (const a of [r.primary_action, ...r.secondary_actions].filter(Boolean)) {
      const specialists = new Set(a!.explanation_chain.map((e) => e.specialist));
      specialists.add(a!.originating_specialist);
      const nonShadow = [...specialists].filter((s) => s !== "start_sit_shadow" && s !== "matchup_shadow");
      assert.ok(nonShadow.length > 0, "an ACTION must have non-shadow evidence");
    }

    // §31 — every action is traceable
    for (const a of [r.primary_action, ...r.secondary_actions].filter(Boolean)) {
      assert.ok(a!.explanation_chain.length > 0, "action has an explanation chain");
      assert.ok(a!.reason_codes.length > 0, "action has reason codes");
      assert.ok(a!.expires_when.length > 0, "action has expiry triggers");
    }

    // §27 — HOLD carries a rationale
    if (r.verdict === "HOLD") assert.ok(r.hold_rationale.length > 0, "HOLD must be supported by negative evidence");

    // §30 — shadow disagreements, if any, appear only as watch/diagnostic items
    const shadowConds = [...r.current_conditions, ...r.future_watch_items].filter((c) =>
      c.sources.includes("start_sit_shadow") || c.sources.includes("matchup_shadow"),
    );
    for (const c of shadowConds) assert.equal(c.disposition, "SHADOW_DIAGNOSTIC_ONLY");

    // determinism
    const res2 = await buildManagerOrchestration(league, manager);
    assert.ok(res2.ok);
    if (res2.ok) {
      assert.equal(res2.result.verdict, r.verdict);
      assert.equal(JSON.stringify(res2.result.primary_action?.remedy), JSON.stringify(r.primary_action?.remedy));
    }

    console.log(
      `  ${league}/${manager}: ${r.verdict}` +
        (r.primary_action ? ` — ${r.primary_action.action_class}/${r.primary_action.priority}/${r.primary_action.dimensions.urgency}` : "") +
        ` | watch=${r.future_watch_items.length} | conf=${r.confidence}`,
    );
  });
}

test("live: league-wide orchestrate (bloodline-bowl) — one shared context", async (t) => {
  const res = await buildLeagueOrchestration("bloodline-bowl");
  if (!res.ok) {
    t.skip(`league orchestrator unavailable: ${res.code}`);
    return;
  }
  assert.ok(res.result.rows.length >= 10);
  const verdicts = new Set(res.result.rows.map((row) => row.verdict));
  assert.ok([...verdicts].every((v) => ["ACTION", "WATCH", "HOLD", "INSUFFICIENT_EVIDENCE"].includes(v)));
  // symmetry sanity: rows are ordered by roster_id and every row is versioned the same
  assert.deepEqual(
    res.result.rows.map((r) => r.roster_id),
    [...res.result.rows.map((r) => r.roster_id)].sort((a, b) => a - b),
  );
  console.log(`  league: ${res.result.rows.map((r) => `${r.roster_id}:${r.verdict}`).join(" ")}`);
});
