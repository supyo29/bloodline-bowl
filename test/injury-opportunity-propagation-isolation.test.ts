// ===========================================================================
// Injury -> Opportunity Propagation Intelligence -- structural production
// isolation (Checkpoint B spec §36 item 30/§41; Checkpoint D spec §54-56,
// §63-64).
//
// This is the permanent regression tripwire across every Phase 3
// checkpoint: no production numeric consumer may ever reference the
// propagation substrate or served product, regardless of what Checkpoint D
// serves. Updated for Checkpoint D's actual served product location
// (`lib/opportunity-propagation-intelligence/`) -- Checkpoints B/C's
// "no TS product yet" assertion is now Checkpoint D's "TS product exists,
// but zero production consumer imports it" assertion.
// ===========================================================================
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

function grepDirForOpportunityPropagation(dir: string): string[] {
  const hits: string[] = [];
  const fullDir = join(process.cwd(), dir);
  let dirents;
  try {
    dirents = readdirSync(fullDir, { withFileTypes: true });
  } catch {
    return hits;
  }
  for (const entry of dirents) {
    const full = join(fullDir, entry.name);
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...grepDirForOpportunityPropagation(rel));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      const text = readFileSync(full, "utf8");
      if (/injury-opportunity-propagation|opportunity-propagation-intelligence|opportunity_propagation|OpportunityPropagationIntelligence|evaluateOpportunityPropagationScenario/.test(text)) {
        hits.push(rel);
      }
    }
  }
  return hits;
}

describe("production isolation (Phase 3, Checkpoint D)", () => {
  test("no production consumer references the opportunity-propagation substrate or served product", () => {
    const hits = [
      ...grepDirForOpportunityPropagation("lib/weekly"),
      ...grepDirForOpportunityPropagation("lib/trades"),
      ...grepDirForOpportunityPropagation("lib/orchestrator"),
      ...grepDirForOpportunityPropagation("lib/projections"),
      ...grepDirForOpportunityPropagation("app/api"),
    ];
    assert.deepEqual(hits, [], `unexpected opportunity-propagation reference(s) in production code: ${hits.join(", ")}`);
  });

  test("Checkpoint D's served TS product exists at lib/opportunity-propagation-intelligence/", () => {
    assert.ok(existsSync(join(process.cwd(), "lib", "opportunity-propagation-intelligence", "index.ts")));
  });

  test("lib/player-role-intelligence (Phase 2, frozen) is untouched by Checkpoint D", () => {
    const text = readFileSync(join(process.cwd(), "lib", "player-role-intelligence", "schema.ts"), "utf8");
    assert.ok(!/opportunity-propagation-intelligence|opportunity_propagation|OpportunityPropagationIntelligence/.test(text));
  });

  test("lib/canonical/lineage.ts's Phase 3 addition is purely additive -- existing RecommendationLineage literals still typecheck with opportunity_propagation_intelligence omitted/null", () => {
    const text = readFileSync(join(process.cwd(), "lib", "canonical", "lineage.ts"), "utf8");
    assert.match(text, /opportunity_propagation_intelligence\?:/, "field must be optional -- additive, never required");
    assert.match(text, /opportunityPropagationIntelligence: OpportunityPropagationIntelligenceLineage \| null = null/, "buildRecommendationLineage's new param must default to null -- existing call sites keep producing null unmodified");
  });

  test("orchestrator directory has zero references to the propagation model or scenario evaluator (spec §55)", () => {
    const hits = grepDirForOpportunityPropagation("lib/orchestrator");
    assert.deepEqual(hits, []);
  });

  test("no waiver/start-sit/matchup/trade/projection engine imports the scenario evaluator (spec §54, exact enumerated list)", () => {
    const dirs = ["lib/weekly/waivers", "lib/weekly/start-sit", "lib/weekly/matchup", "lib/trades", "lib/projections", "lib/weekly/lineup"];
    const hits = dirs.flatMap((d) => grepDirForOpportunityPropagation(d));
    assert.deepEqual(hits, []);
  });
});
