/**
 * Reproduce the W1.P2 injury-prior counts and held-out evaluation:
 *   npx tsx scripts/injury-calibration.ts            # print report
 *   npx tsx scripts/injury-calibration.ts --write    # also write lib/weekly/forecast/data/injury-calibration-report.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCalibration } from "./lib/injury-calibration";

const report = runCalibration();
const json = JSON.stringify(report, null, 2);
console.log(json);
if (process.argv.includes("--write")) {
  const dir = join(process.cwd(), "lib/weekly/forecast/data");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "injury-calibration-report.json"), json + "\n");
  console.error("wrote lib/weekly/forecast/data/injury-calibration-report.json");
}
