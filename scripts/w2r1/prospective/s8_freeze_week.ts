/**
 * W2.R1 S8: freeze a week's PREGAME belief. Usage: npx tsx scripts/w2r1/prospective/s8_freeze_week.ts <week> <firstKickoffISO>
 * Requires lib/w2r1/data/prospective/wkNN/{kdst_components,upside}.json produced by s8_pregame_kdst.R / s8_pregame_upside.R. Refuses to run at/after the first kickoff and refuses to overwrite a manifest.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { buildManifest, MANIFEST_NAME } from "../../../lib/w2r1/capture";
import { qualificationSummary, W2R1_RESEARCH_VERDICT } from "../../../lib/w2r1/qualification";
import { REGIMES } from "../../../lib/w2r1/dst-live";

const week = Number(process.argv[2]); const kickoff = process.argv[3]!;
if (!Number.isInteger(week) || !kickoff) throw new Error("usage: s8_freeze_week.ts <week> <firstKickoffISO>");
const dir = `lib/w2r1/data/prospective/wk${String(week).padStart(2, "0")}`;
if (existsSync(`${dir}/${MANIFEST_NAME}`)) throw new Error("manifest exists: the week is frozen and must not be rewritten");
const now = new Date().toISOString(); if (Date.parse(now) >= Date.parse(kickoff)) throw new Error(`refusing: now ${now} >= first kickoff ${kickoff}`);
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const q = { schema: "w2r1-s8-qualification-snapshot-1", season: 2026, week, research_verdict: W2R1_RESEARCH_VERDICT, captured_at: now,
  by_league: Object.fromEntries(Object.keys(REGIMES).map((l) => [l, qualificationSummary(l)])),
  tactical_evidence_state: { tactical_signal: "NO_RELIABLE_INCREMENTAL_SIGNAL", applied_to_forecast: false, note: "non-predictive; recorded for provenance only" },
  role_state: "W2.P1 Role candidate C2 (frozen, scripts/w2p1/FROZEN.json) — SHADOW; not applied to live forecasts here",
  confidence: { dst: "MEDIUM for QUALIFIED_SHADOW leagues; LOW elsewhere", k: "LOW (diagnostic)", upside_te: "LOW (insufficient final sample)" },
  model_artifact_hashes: { frozen_json_sha256: sha("scripts/w2r1/FROZEN.json"), frozen_sha256_file: readFileSync("scripts/w2r1/FROZEN.sha256", "utf8").trim(), qualification_ts_sha256: sha("lib/w2r1/qualification.ts"), dst_live_ts_sha256: sha("lib/w2r1/dst-live.ts"), kdst_ts_sha256: sha("lib/w2r1/kdst.ts"), s4_regimes_sha256: sha("scripts/w2r1/s4_regimes.json"), git_head: execSync("git rev-parse HEAD").toString().trim() },
  scoring_fingerprints: "league scoring regimes are the exact keys in scripts/w2r1/s4_regimes.json (sha above); live league fingerprints are captured by the live LEAGUE_MANAGER_STATE capture, not here",
  coverage_notes: { LEAGUE_MANAGER_STATE: "NOT CAPTURED for this week: the W1 canonical forecast, availability, roster, verified market and Dynamic VOR need a credentialed protected deployment (Yahoo/Supabase); not authorized in S8. See the durable staging proposal.", designations: "official designations are not yet published at freeze time; unknown designations are treated as NONE (flagged) and OUT is excluded from the upside population" } };
writeFileSync(`${dir}/qualification.json`, JSON.stringify(q, null, 1) + "\n");
const m = buildManifest(dir, 2026, week, now, kickoff, ["kdst_components.json", "upside.json", "qualification.json"]);
writeFileSync(`${dir}/${MANIFEST_NAME}`, JSON.stringify(m, null, 1) + "\n");
// register the week in the bundled loader index (idempotent)
const idxPath = "lib/w2r1/data/prospective/index.ts"; let idx = readFileSync(idxPath, "utf8"); const wk2 = String(week).padStart(2, "0");
const add = (rec: string, file: string, type: string) => { const line = `  ${week}: () => import("./wk${wk2}/${file}.json").then((m) => m.default as unknown as ${type}),`; if (idx.includes(line)) return; const at = idx.indexOf("};", idx.indexOf(rec)); idx = idx.slice(0, at) + line + "\n" + idx.slice(at); };
add("export const KDST_LOADERS", "kdst_components", "KdstCapture"); add("export const UPSIDE_LOADERS", "upside", "UpsideCapture"); writeFileSync(idxPath, idx);
console.log("frozen", dir, now, "files", Object.keys(m.files).join(","));
