/**
 * W2.P2 G3 evaluation run (research CLI; never part of a request path).
 *
 *   node --import tsx scripts/role-shadow-g3.ts [--records records.json --outcomes outcomes.json] [--out DIR] [--log FILE] [--config-hash H] [--no-log] [--acknowledge-repeat-look]
 *
 * Without --records/--outcomes it READS the production store (needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY): `bridge_role_shadow_captures` for the
 * records and `bridge_calibration_cases_current` for the realized outcomes. It never writes to the database. Output: <out>/bundle.json (the exact input,
 * so the report is reproducible offline) and <out>/report.json. Exit 0 = report written; 3 = a repeated DECISION look was refused.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadSupabaseConfig, SupabaseRest } from "../lib/persistence/supabase/rest";
import { loadCalibrationOutcomes } from "../lib/persistence/supabase/role-shadow-outcomes";
import { SupabaseRoleShadowStore } from "../lib/persistence/supabase/role-shadow-store";
import { runG3, type CliIO } from "../lib/role-shadow/g3-cli";
import type { OutcomeRow } from "../lib/role-shadow/g3";
import type { RoleShadowRecord } from "../lib/role-shadow/record";

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(n);
const val = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const io: CliIO = {
  exists: (p) => existsSync(p), read: (p) => readFileSync(p, "utf8"), write: (p, d) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, d); },
  append: (p, d) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, d); }, mkdirp: (p) => mkdirSync(p, { recursive: true }), now: () => new Date().toISOString(),
};

async function main(): Promise<void> {
  const recordsFile = val("--records");
  const outcomesFile = val("--outcomes");
  let rest: SupabaseRest | null = null;
  if (!recordsFile || !outcomesFile) {
    const cfg = loadSupabaseConfig();
    if (!cfg.configured || !cfg.config) { console.error(`Supabase is not configured (missing ${cfg.missing.join(", ")}); pass --records and --outcomes files instead.`); process.exit(2); }
    rest = new SupabaseRest(cfg.config);
  }
  const res = await runG3(
    { out: val("--out") ?? "outputs/role-shadow-g3", log: val("--log") ?? "docs/evidence/role-shadow-g3-run-log.jsonl", acknowledgeRepeatLook: flag("--acknowledge-repeat-look"), noLog: flag("--no-log"), configHash: val("--config-hash") },
    io,
    {
      records: async () => (recordsFile ? (JSON.parse(readFileSync(recordsFile, "utf8")) as RoleShadowRecord[]) : new SupabaseRoleShadowStore(rest!).list()),
      outcomes: async (records) => (outcomesFile ? (JSON.parse(readFileSync(outcomesFile, "utf8")) as OutcomeRow[]) : loadCalibrationOutcomes(rest!, records)),
    },
  );
  console.log(res.message);
  if (res.report) console.log(JSON.stringify({ verdict: res.report.verdict, look: res.report.look, positions: Object.fromEntries(Object.entries(res.report.positions).map(([k, v]) => [k, { verdict: v.verdict, sufficiency: v.sufficiency.unmet }])), input: res.report.input }, null, 1));
  process.exit(res.exit);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
