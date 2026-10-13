/**
 * W2.P2 — the G3 evaluation run: load captured records + outcomes, write the INPUT BUNDLE (so the report is reproducible offline), evaluate, write
 * the report, and enforce the look policy (`scripts/w2p2/g3-prereg.json` look_policy): any evaluation before sufficiency is DESCRIPTIVE_INTERIM and
 * never logged; the first DECISION look per challenger config hash is logged, and a second one is refused unless explicitly acknowledged.
 * I/O is injected so the whole flow is unit-testable; `scripts/role-shadow-g3.ts` is the thin wrapper that supplies the filesystem and Supabase.
 */
import { createHash } from "node:crypto";
import { evaluateG3, type G3Bundle, type G3Report, type OutcomeRow } from "./g3";
import type { RoleShadowRecord } from "./record";
import { PINNED } from "./spec";

export interface CliIO {
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, data: string): void;
  append(path: string, data: string): void;
  mkdirp(path: string): void;
  now(): string;
}
export interface CliArgs { out: string; log: string; acknowledgeRepeatLook: boolean; noLog: boolean; configHash?: string }
export interface Loaders { records: () => Promise<RoleShadowRecord[]>; outcomes: (records: RoleShadowRecord[]) => Promise<OutcomeRow[]> }
export interface CliResult { exit: 0 | 3; report: G3Report | null; bundle_sha256: string | null; message: string; logged: boolean }

export interface RunLogEntry { at: string; challenger_config_hash: string; verdict: string; report_digest: string; bundle_sha256: string; repeated_look: boolean }

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export function readRunLog(io: CliIO, path: string): RunLogEntry[] {
  if (!io.exists(path)) return [];
  return io.read(path).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as RunLogEntry);
}

export async function runG3(args: CliArgs, io: CliIO, loaders: Loaders): Promise<CliResult> {
  const hash = args.configHash ?? PINNED.challenger_config_hash;
  const records = await loaders.records();
  const outcomes = await loaders.outcomes(records);
  const bundle: G3Bundle = { records, outcomes };
  const bundleText = JSON.stringify(bundle);
  const bundle_sha256 = sha256(bundleText);
  const report = evaluateG3(bundle, { challenger_config_hash: hash });

  const prior = readRunLog(io, args.log).filter((e) => e.challenger_config_hash === hash);
  const repeated = report.look === "DECISION" && prior.length > 0;
  if (repeated && !args.acknowledgeRepeatLook) {
    return {
      exit: 3, report: null, bundle_sha256, logged: false,
      message: `REFUSED: a DECISION look for challenger config ${hash} was already logged (${prior[0]!.at}, ${prior[0]!.verdict}). Re-evaluating the same model after seeing its result is forbidden by the pre-registered look policy. Pass --acknowledge-repeat-look to produce a clearly labeled REPEATED_LOOK report.`,
    };
  }
  if (repeated) report.notes.push("REPEATED_LOOK: a DECISION look for this model was already logged; this report is not an independent decision.");

  io.mkdirp(args.out);
  io.write(`${args.out}/bundle.json`, bundleText);
  io.write(`${args.out}/report.json`, JSON.stringify(report, null, 1));
  let logged = false;
  if (report.look === "DECISION" && !args.noLog) {
    const entry: RunLogEntry = { at: io.now(), challenger_config_hash: hash, verdict: report.verdict, report_digest: report.report_digest, bundle_sha256, repeated_look: repeated };
    io.append(args.log, JSON.stringify(entry) + "\n");
    logged = true;
  }
  return { exit: 0, report, bundle_sha256, logged, message: `${report.look} ${report.verdict} (report_digest ${report.report_digest}, bundle ${bundle_sha256.slice(0, 16)})` };
}
