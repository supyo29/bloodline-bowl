/** Phase 6 — writes the machine-readable scoring support matrix. `npx tsx scripts/scoring-support-matrix.ts` */
import { writeFileSync } from "node:fs";
import { buildSupportMatrix, countByClass } from "../lib/scoring/support-contract";
const rows = buildSupportMatrix();
writeFileSync("docs/scoring-support-matrix.json", JSON.stringify({ generated_for: "Intelligence Modernization Phase 6", key_count: rows.length, by_class: countByClass(rows), rules: rows }, null, 1) + "\n");
console.log(rows.length, "rules", JSON.stringify(countByClass(rows)));
