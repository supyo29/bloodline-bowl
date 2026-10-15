/**
 * Player-Scheme build-certification reports (tracked copies in lib/player-scheme-intelligence/certification/). The reports used to live only in the gitignored outputs/ directory, so the
 * tests that read them passed only on the machine that had run the R build. They are now tracked AND bound to the committed served data: a report whose `served_content_sha256` no longer
 * equals what the committed manifest records fails here. (Re-deriving the reports from raw data is the separate `scripts/player-scheme-recertify.sh` path.)
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const CERT = join(process.cwd(), "lib", "player-scheme-intelligence", "certification");
const manifest = JSON.parse(readFileSync(join(process.cwd(), "lib", "player-scheme-intelligence", "data", "player_scheme_manifest.json"), "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const report = (n: string): Record<string, any> => JSON.parse(readFileSync(join(CERT, n), "utf8")); // eslint-disable-line @typescript-eslint/no-explicit-any

test("the tracked report bytes match the recorded checksums (no hand edits)", () => {
  const sums = readFileSync(join(CERT, "SHA256SUMS"), "utf8").trim().split("\n").map((l) => l.trim().split(/\s+/) as [string, string]);
  const files = readdirSync(CERT).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(sums.map(([, f]) => f).sort(), files, "every tracked report is listed, nothing extra");
  for (const [sha, f] of sums) assert.equal(createHash("sha256").update(readFileSync(join(CERT, f))).digest("hex"), sha, f);
});
test("every reconciliation report passes and is BOUND to the committed served data", () => {
  const a = report("tierA_reconciliation.json");
  assert.equal(a.all_pass, true); assert.ok(String(manifest.player_scheme_version).endsWith(String(a.served_content_sha256).slice(0, 12)), "Tier A: the served version embeds the report's content hash");
  for (const [file, tier] of [["tierB_reconciliation.json", "tier_b"], ["tierC_reconciliation.json", "tier_c"], ["tierD_reconciliation.json", "tier_d"]] as const) {
    const r = report(file); assert.equal(r.all_pass, true, file);
    assert.equal(r.served_content_sha256, manifest[tier].served_content_sha256, `${file}: report hash must equal the committed manifest's ${tier}.served_content_sha256`);
    assert.equal(manifest[tier].reconciliation_all_pass, true, tier);
  }
  assert.equal(manifest.reconciliation_all_pass, true);
});
test("Tier D remains SHADOW_ONLY with a zero fantasy adjustment (the committed manifest says so, and the report agrees)", () => {
  assert.equal(manifest.fantasy_adjustment_enabled, false); assert.equal(manifest.tier_d.lane, "SHADOW_ONLY"); assert.equal(manifest.tier_d.numeric_fantasy_adjustment, 0);
  assert.equal(report("tierD_reconciliation.json").all_shadow_only, true);
});
