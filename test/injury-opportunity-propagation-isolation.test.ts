// ===========================================================================
// Injury -> Opportunity Propagation Intelligence -- Checkpoint B structural
// production isolation (spec §36 item 30, §41).
//
// Checkpoint B introduces NO TypeScript product yet (spec §34: internal R
// artifacts only). This test exists as a regression tripwire for every
// future checkpoint: it must keep passing right up through Checkpoint D's
// served product, at which point it proves the served read contract is
// still never imported by a production recommendation path.
// ===========================================================================
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
      if (/injury-opportunity-propagation|opportunity_propagation|OpportunityPropagationIntelligence/.test(text)) {
        hits.push(rel);
      }
    }
  }
  return hits;
}

describe("production isolation (Phase 3, Checkpoint B)", () => {
  test("no production consumer references the opportunity-propagation substrate", () => {
    const hits = [
      ...grepDirForOpportunityPropagation("lib/weekly"),
      ...grepDirForOpportunityPropagation("lib/trades"),
      ...grepDirForOpportunityPropagation("lib/orchestrator"),
      ...grepDirForOpportunityPropagation("lib/projections"),
      ...grepDirForOpportunityPropagation("app/api"),
    ];
    assert.deepEqual(hits, [], `unexpected opportunity-propagation reference(s) in production code: ${hits.join(", ")}`);
  });

  test("Checkpoint B has not created a lib/injury-opportunity-propagation TS product yet", () => {
    let exists = true;
    try {
      readdirSync(join(process.cwd(), "lib", "injury-opportunity-propagation"));
    } catch {
      exists = false;
    }
    assert.equal(exists, false, "Checkpoint B is internal-only (R artifacts); a TS product is Checkpoint D's deliverable, not this checkpoint's");
  });

  test("lib/player-role-intelligence (Phase 2) is untouched by this checkpoint", () => {
    const text = readFileSync(join(process.cwd(), "lib", "player-role-intelligence", "schema.ts"), "utf8");
    assert.ok(!/injury-opportunity-propagation|opportunity_propagation/.test(text));
  });

  test("lib/canonical/lineage.ts is untouched by this checkpoint (no propagation lineage type added yet)", () => {
    const text = readFileSync(join(process.cwd(), "lib", "canonical", "lineage.ts"), "utf8");
    assert.ok(!/OpportunityPropagationIntelligenceLineage/.test(text));
  });
});
